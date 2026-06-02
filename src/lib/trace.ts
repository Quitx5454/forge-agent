// ─────────────────────────────────────────────────────────────
// Trace — agent execution log → structured JSON + forge_ready.
//
// Takes a raw agent execution log (plaintext or JSON in several
// dialects), normalizes it into a list of execution steps + a
// summary, and emits a `forge_ready` block that plugs straight into
// the Forge entrypoint (ERC-8004 feedback) — suggested score + tags.
//
// Parsing is HYBRID:
//   • Structured dialects (OpenTelemetry / LangChain / OpenAI) are
//     parsed rule-based (fast, no LLM).
//   • Plaintext / generic JSON is parsed with Claude Haiku.
// Logs over 100KB are line-chunked (≤50KB each) and parsed in
// parallel, then merged.
//
// Failure handling:
//   • empty log            → throws TraceError(400)
//   • parse fails entirely → returns a `status:"failed"` output with
//     steps:[] and forge_ready.can_submit:false (the Lucid express
//     adapter flushes headers before the body streams, so a true 422
//     can't be emitted from a handler — we mirror Forge's
//     ready_to_sign:false convention instead).
// ─────────────────────────────────────────────────────────────
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const CHUNK_THRESHOLD = 100 * 1024; // 100KB
const CHUNK_MAX = 50 * 1024; //  50KB
const ZERO_AGENT = "0x0000000000000000000000000000000000000000";

// ── Types ─────────────────────────────────────────────────────
export type TraceFormat = "auto" | "plaintext" | "json" | "opentelemetry" | "langchain" | "openai";

export interface TraceInput {
  log: string;
  format?: TraceFormat;
  session_id?: string;
  agent_id?: string;
}

export type StepStatus = "ok" | "error" | "retry" | "timeout";

export interface TraceStep {
  index: number;
  timestamp: string;
  action: string;
  status: StepStatus;
  duration_ms: number;
  tokens_used: number;
  cost_usdc: number;
  endpoint: string | null;
  error: string | null;
}

export interface TraceSummary {
  total_steps: number;
  total_duration_ms: number;
  total_tokens: number;
  total_cost_usdc: number;
  errors: string[];
  retries: number;
  status: "completed" | "failed" | "partial";
}

export interface ForgeReady {
  can_submit: boolean;
  suggested_score: number;
  suggested_tag1: string;
  suggested_tag2: "execution_success" | "execution_failed";
}

export interface TraceOutput {
  session_id: string;
  agent_id: string;
  steps: TraceStep[];
  summary: TraceSummary;
  forge_ready: ForgeReady;
  processed_at: string;
  error?: string;
}

// HTTP-aware error. `status` is honored by direct callers / tests;
// the HTTP layer maps empty-log to 400 via the zod schema.
export class TraceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TraceError";
    this.status = status;
  }
}

// Shape the Haiku prompt asks for (a partial of the final output).
interface ParsedSteps {
  steps: Array<Partial<TraceStep>>;
  errors: string[];
  retries: number;
}

// ── 1. FORMAT DETECTION ───────────────────────────────────────
export function detectFormat(log: string): Exclude<TraceFormat, "auto"> {
  let obj: any;
  try {
    obj = JSON.parse(log);
  } catch {
    return "plaintext";
  }
  if (obj && typeof obj === "object") {
    if (obj.traceId !== undefined && obj.spanId !== undefined && obj.attributes !== undefined) {
      return "opentelemetry";
    }
    if (obj.lc !== undefined && obj.type !== undefined && obj.id !== undefined) {
      return "langchain";
    }
    if (obj.choices !== undefined && hasToolCalls(obj)) {
      return "openai";
    }
  }
  return "json";
}

function hasToolCalls(obj: any): boolean {
  if (!Array.isArray(obj.choices)) return false;
  return obj.choices.some((c: any) => Array.isArray(c?.message?.tool_calls) && c.message.tool_calls.length > 0);
}

// ── 2. RULE-BASED PARSERS (no LLM) ────────────────────────────
function attrValue(v: any): any {
  if (v == null || typeof v !== "object") return v;
  // OpenTelemetry AnyValue: { intValue | stringValue | doubleValue | boolValue }
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("stringValue" in v) return v.stringValue;
  if ("boolValue" in v) return v.boolValue;
  return v;
}

export function parseOpenTelemetry(obj: any): ParsedSteps {
  const attrs: Record<string, any> = {};
  for (const a of obj.attributes ?? []) {
    if (a && a.key !== undefined) attrs[String(a.key)] = attrValue(a.value);
  }

  const pick = (...names: string[]): any => {
    for (const key of Object.keys(attrs)) {
      const lk = key.toLowerCase();
      if (names.some((n) => lk.includes(n))) return attrs[key];
    }
    return undefined;
  };

  const tokens_used = Number(pick("token") ?? 0) || 0;
  const cost_usdc = Number(pick("cost", "usdc", "price") ?? 0) || 0;
  let duration_ms = Number(pick("duration") ?? 0) || 0;
  if (!duration_ms && obj.startTimeUnixNano && obj.endTimeUnixNano) {
    duration_ms = (Number(obj.endTimeUnixNano) - Number(obj.startTimeUnixNano)) / 1e6;
  }

  const isError = obj.status?.code === 2 || String(obj.status?.code ?? "").toUpperCase().includes("ERROR");
  const ts = obj.startTimeUnixNano ? new Date(Number(obj.startTimeUnixNano) / 1e6).toISOString() : "";

  const step: Partial<TraceStep> = {
    timestamp: ts,
    action: String(obj.name ?? attrs["action"] ?? "span"),
    status: isError ? "error" : "ok",
    duration_ms: Math.round(duration_ms),
    tokens_used,
    cost_usdc,
    endpoint: (pick("endpoint", "url", "http.url") ?? null) as string | null,
    error: isError ? String(obj.status?.message ?? "error") : null,
  };

  return { steps: [step], errors: isError ? [step.error as string] : [], retries: 0 };
}

export function parseLangchain(obj: any): ParsedSteps {
  const kwargs = obj.kwargs ?? {};
  const action = String(kwargs.action ?? kwargs.tool ?? obj.id?.[obj.id.length - 1] ?? "langchain_step");
  const inputs = kwargs.inputs ?? kwargs.input ?? null;
  const step: Partial<TraceStep> = {
    timestamp: String(kwargs.timestamp ?? ""),
    action,
    status: "ok",
    duration_ms: Number(kwargs.duration_ms ?? 0) || 0,
    tokens_used: Number(kwargs.tokens_used ?? kwargs.total_tokens ?? 0) || 0,
    cost_usdc: Number(kwargs.cost_usdc ?? 0) || 0,
    endpoint: typeof inputs === "string" ? inputs : null,
    error: null,
  };
  return { steps: [step], errors: [], retries: 0 };
}

export function parseOpenAI(obj: any): ParsedSteps {
  const steps: Array<Partial<TraceStep>> = [];
  for (const choice of obj.choices ?? []) {
    const calls = choice?.message?.tool_calls ?? [];
    for (const call of calls) {
      const fn = call?.function ?? {};
      steps.push({
        timestamp: obj.created ? new Date(Number(obj.created) * 1000).toISOString() : "",
        action: String(fn.name ?? "tool_call"),
        status: "ok",
        duration_ms: 0,
        tokens_used: Number(obj.usage?.total_tokens ?? 0) || 0,
        cost_usdc: 0,
        endpoint: typeof fn.arguments === "string" ? fn.arguments.slice(0, 200) : null,
        error: null,
      });
    }
  }
  if (steps.length === 0) {
    steps.push({ action: "completion", status: "ok", duration_ms: 0, tokens_used: Number(obj.usage?.total_tokens ?? 0) || 0, cost_usdc: 0, endpoint: null, error: null, timestamp: "" });
  }
  return { steps, errors: [], retries: 0 };
}

// ── 3. HAIKU PARSER (plaintext / generic JSON) ────────────────
const SYSTEM_PROMPT =
  "You are an expert log parser for autonomous AI agents in the Web3/x402 ecosystem. " +
  "Extract execution steps from the log. Return ONLY valid JSON, no markdown, no explanation:\n" +
  `{
  "steps": [{
    "index": 1,
    "timestamp": "ISO string or empty",
    "action": "string",
    "status": "ok|error|retry|timeout",
    "duration_ms": 0,
    "tokens_used": 0,
    "cost_usdc": 0,
    "endpoint": null,
    "error": null
  }],
  "errors": [],
  "retries": 0
}`;

function stripFences(text: string): string {
  const t = text.trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  // Fall back to the first {...} block if there's surrounding prose.
  const brace = t.match(/\{[\s\S]*\}/);
  return brace ? brace[0] : t;
}

async function haikuParse(client: Anthropic, chunk: string): Promise<ParsedSteps> {
  const msg = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 4096,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: chunk }],
  });
  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = JSON.parse(stripFences(text));
  return {
    steps: Array.isArray(parsed.steps) ? parsed.steps : [],
    errors: Array.isArray(parsed.errors) ? parsed.errors : [],
    retries: Number(parsed.retries ?? 0) || 0,
  };
}

// ── 4. CHUNKING ───────────────────────────────────────────────
function chunkByLines(log: string, max: number): string[] {
  if (log.length <= max) return [log];
  const lines = log.split("\n");
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > max && current.length > 0) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

function mergeParsed(results: ParsedSteps[]): ParsedSteps {
  const steps: Array<Partial<TraceStep>> = [];
  let errors: string[] = [];
  let retries = 0;
  for (const r of results) {
    steps.push(...r.steps);
    errors = errors.concat(r.errors ?? []);
    retries += r.retries ?? 0;
  }
  // Sort by timestamp where present (empty timestamps keep insertion order).
  steps.sort((a, b) => {
    const ta = a.timestamp || "";
    const tb = b.timestamp || "";
    if (!ta && !tb) return 0;
    if (!ta) return 1;
    if (!tb) return -1;
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  return { steps, errors, retries };
}

// Parse via Haiku, chunking when the log exceeds the threshold.
async function parseWithHaiku(log: string): Promise<ParsedSteps> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }
  const client = new Anthropic({ apiKey });

  if (log.length <= CHUNK_THRESHOLD) {
    return haikuParse(client, log);
  }

  const chunks = chunkByLines(log, CHUNK_MAX);
  const settled = await Promise.allSettled(chunks.map((c) => haikuParse(client, c)));
  const ok = settled.filter((s): s is PromiseFulfilledResult<ParsedSteps> => s.status === "fulfilled").map((s) => s.value);
  if (ok.length === 0) {
    throw new Error("all log chunks failed to parse");
  }
  return mergeParsed(ok);
}

// ── 5. FORGE SCORE ────────────────────────────────────────────
export function calculateForgeScore(steps: TraceStep[], errors: string[], retries: number): number {
  let score = 100;
  score -= errors.length * 25;
  score -= retries * 5;
  if (steps.length > 0) {
    const avg = steps.reduce((s, x) => s + (x.duration_ms || 0), 0) / steps.length;
    if (avg > 3000) score -= 10;
  }
  return Math.max(0, Math.min(100, score));
}

// ── Normalize raw parsed steps into the strict TraceStep shape ─
function normalizeSteps(raw: Array<Partial<TraceStep>>): TraceStep[] {
  const allowed: StepStatus[] = ["ok", "error", "retry", "timeout"];
  return raw.map((s, i) => {
    const status = (allowed.includes(s.status as StepStatus) ? s.status : "ok") as StepStatus;
    return {
      index: typeof s.index === "number" ? s.index : i + 1,
      timestamp: s.timestamp ?? "",
      action: String(s.action ?? "step"),
      status,
      duration_ms: Number(s.duration_ms ?? 0) || 0,
      tokens_used: Number(s.tokens_used ?? 0) || 0,
      cost_usdc: Number(s.cost_usdc ?? 0) || 0,
      endpoint: s.endpoint ?? null,
      error: s.error ?? null,
    };
  });
}

function failedOutput(input: TraceInput, message: string): TraceOutput {
  return {
    session_id: input.session_id || randomUUID(),
    agent_id: input.agent_id || ZERO_AGENT,
    steps: [],
    summary: {
      total_steps: 0,
      total_duration_ms: 0,
      total_tokens: 0,
      total_cost_usdc: 0,
      errors: [message],
      retries: 0,
      status: "failed",
    },
    forge_ready: {
      can_submit: false,
      suggested_score: 0,
      suggested_tag1: "x402_execution",
      suggested_tag2: "execution_failed",
    },
    processed_at: new Date().toISOString(),
    error: message,
  };
}

// ── ORCHESTRATION ─────────────────────────────────────────────
export async function processTrace(input: TraceInput): Promise<TraceOutput> {
  // 1. INPUT VALIDATION — empty log is a 400.
  if (!input || typeof input.log !== "string" || input.log.trim() === "") {
    throw new TraceError(400, "log is required and cannot be empty");
  }

  const log = input.log;
  const requested = input.format && input.format !== "auto" ? input.format : detectFormat(log);

  // 2/3. PARSE — rule-based for structured dialects, Haiku otherwise.
  let parsed: ParsedSteps;
  try {
    switch (requested) {
      case "opentelemetry":
        parsed = parseOpenTelemetry(JSON.parse(log));
        break;
      case "langchain":
        parsed = parseLangchain(JSON.parse(log));
        break;
      case "openai":
        parsed = parseOpenAI(JSON.parse(log));
        break;
      case "plaintext":
      case "json":
      default:
        parsed = await parseWithHaiku(log);
        break;
    }
  } catch (err: any) {
    // Parse failed entirely → failed output (steps:[], status:"failed").
    return failedOutput(input, err?.message ?? "failed to parse log");
  }

  const steps = normalizeSteps(parsed.steps);

  // Errors come from the parser plus any step flagged error/timeout.
  const stepErrors = steps
    .filter((s) => s.status === "error" || s.status === "timeout")
    .map((s) => s.error ?? `${s.action} ${s.status}`);
  const errors = Array.from(new Set([...(parsed.errors ?? []), ...stepErrors]));
  const retries = (parsed.retries ?? 0) + steps.filter((s) => s.status === "retry").length;

  // 6. SUMMARY
  const total_duration_ms = steps.reduce((s, x) => s + x.duration_ms, 0);
  const total_tokens = steps.reduce((s, x) => s + x.tokens_used, 0);
  const total_cost_usdc = steps.reduce((s, x) => s + x.cost_usdc, 0);

  let status: TraceSummary["status"];
  if (errors.length > 0) status = "failed";
  else if (retries > 0) status = "partial";
  else status = "completed";

  const suggested_score = calculateForgeScore(steps, errors, retries);

  return {
    session_id: input.session_id || randomUUID(),
    agent_id: input.agent_id || ZERO_AGENT,
    steps,
    summary: {
      total_steps: steps.length,
      total_duration_ms,
      total_tokens,
      total_cost_usdc,
      errors,
      retries,
      status,
    },
    forge_ready: {
      can_submit: steps.length > 0,
      suggested_score,
      suggested_tag1: "x402_execution",
      suggested_tag2: errors.length > 0 ? "execution_failed" : "execution_success",
    },
    processed_at: new Date().toISOString(),
  };
}
