// Local test for the Distill Standard Envelope (bypasses the x402 paywall).
//   bun run test-envelope.ts
//
// Mirrors the trace entrypoint handler exactly: parseEnvelope -> processTrace
// -> wrapResponse. Verifies envelope mode + legacy (backward-compat) mode.
// Runs the real pipeline, so ANTHROPIC_API_KEY should be set (Bun loads .env).
import { parseEnvelope, wrapResponse, type DistillResponse } from "./src/lib/envelope";
import { processTrace, type TraceInput } from "./src/lib/trace";

const TRACE_INPUT: TraceInput = {
  log: "[2026-06-02 10:00:01] fetch_data completed in 340ms. Tokens: 1200. USDC: 0.02. Status: OK",
};

async function runTrace(raw: unknown): Promise<DistillResponse> {
  const { payload, sessionId, agentId } = parseEnvelope<TraceInput>(raw);
  const output = await processTrace(payload);
  return wrapResponse(output, sessionId, agentId, "ok");
}

function assert(cond: boolean, msg: string) {
  console.log(`${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) process.exitCode = 1;
}

function checkEnvelopeResponse(res: DistillResponse, label: string, expectSession: string | null, expectAgent: string | null) {
  assert(res.distill_version === "1.0", `${label}: distill_version === '1.0'`);
  if (expectSession) assert(res.session_id === expectSession, `${label}: session_id preserved`);
  else assert(typeof res.session_id === "string" && res.session_id.length >= 32, `${label}: session_id auto-generated (UUID)`);
  assert(res.agent_id === expectAgent, `${label}: agent_id === ${JSON.stringify(expectAgent)}`);
  assert(res.status === "ok", `${label}: status === 'ok'`);
  assert(typeof res.processed_at === "string" && !isNaN(Date.parse(res.processed_at)), `${label}: processed_at is ISO timestamp`);
  assert(res.output !== undefined, `${label}: output present`);
}

// ── TRACE — Scenario 1: Envelope ──────────────────────────────────
console.log("\n── TRACE · Envelope mode ─────────────────────────");
const tEnv = { distill_version: "1.0", agent_id: "6482", session_id: "test-session-001", payload: TRACE_INPUT };
const tParsed = parseEnvelope<TraceInput>(tEnv);
assert(tParsed.isEnvelope && (tParsed.payload as TraceInput).log === TRACE_INPUT.log, "trace: payload unwrapped");
checkEnvelopeResponse(await runTrace(tEnv), "trace envelope", "test-session-001", "6482");

// ── TRACE — Scenario 2: Legacy ────────────────────────────────────
console.log("\n── TRACE · Legacy mode ───────────────────────────");
checkEnvelopeResponse(await runTrace(TRACE_INPUT), "trace legacy", null, null);

console.log(process.exitCode ? "\n❌ SOME CHECKS FAILED" : "\n✅ ALL CHECKS PASSED");
