// Local smoke-test for the Trace core pipeline (bypasses the x402 paywall).
//   bun run test-trace
//
// Scenario 1 — plaintext log  → Haiku parse
// Scenario 2 — JSON log        → Haiku parse
// Scenario 3 — empty log       → TraceError(400)
//
// Scenarios 1 & 2 call Claude Haiku, so ANTHROPIC_API_KEY must be set
// (Bun auto-loads it from .env).
import { processTrace, detectFormat, TraceError, type TraceInput } from "./src/lib/trace";

async function run(label: string, input: TraceInput) {
  console.log(`\n── ${label} ──────────────────────────────────`);
  console.log("format detected:", input.format && input.format !== "auto" ? input.format : detectFormat(input.log));
  try {
    const out = await processTrace(input);
    console.log(JSON.stringify(out, null, 2));
    return out;
  } catch (err) {
    if (err instanceof TraceError) {
      console.log(`TraceError ${err.status}: ${err.message}`);
      return err;
    }
    throw err;
  }
}

// ── Scenario 1 — plaintext ────────────────────────────────────
await run("SCENARIO 1 — plaintext", {
  log: "[2026-06-02 10:00:01] fetch_data completed in 340ms. Tokens: 1200. USDC: 0.02. Status: OK",
});

// ── Scenario 2 — JSON ─────────────────────────────────────────
await run("SCENARIO 2 — json", {
  log: '{"level":30,"time":1717320000000,"msg":"Payment executing","action":"x402_payment","network":"eip155:8453","price":"0.02","duration_ms":450}',
});

// ── Scenario 3 — empty (expects 400) ──────────────────────────
const empty = await run("SCENARIO 3 — empty (expect 400)", { log: "" });

console.log("\n── ASSERTIONS ────────────────────────────────────");
const ok =
  empty instanceof TraceError && empty.status === 400;
console.log(`${ok ? "✅" : "❌"} empty log → TraceError 400`);
if (!ok) process.exit(1);
console.log("\nALL CHECKS PASSED");
