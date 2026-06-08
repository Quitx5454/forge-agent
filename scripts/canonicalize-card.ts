// One-time helper: print the RFC 8785 (JCS) canonical form of the agent card.
//
//   bun run scripts/canonicalize-card.ts                       # trace-agent-card.json
//   bun run scripts/canonicalize-card.ts trace-agent-card.json # explicit
//
// Canonicalization only — this does NOT sign the card. Signing (filling the
// `signatures` array) is a separate, future step that will consume this output.
//
import { canonicalize } from "json-canonicalize";

const file = process.argv[2] ?? "trace-agent-card.json";
const card = await import(`../${file}`, { with: { type: "json" } }).then((m) => m.default);

process.stdout.write(canonicalize(card) + "\n");
