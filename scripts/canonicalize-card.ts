// One-time helper: print the RFC 8785 (JCS) canonical form of an agent card.
//
// This repo serves two cards (Forge and Trace), so the file is selectable:
//
//   bun run scripts/canonicalize-card.ts                       # agent-card.json (Forge)
//   bun run scripts/canonicalize-card.ts trace-agent-card.json # Trace
//
// Canonicalization only — this does NOT sign the card. Signing (filling the
// `signatures` array) is a separate, future step that will consume this output.
//
import { canonicalize } from "json-canonicalize";

const file = process.argv[2] ?? "agent-card.json";
const card = await import(`../${file}`, { with: { type: "json" } }).then((m) => m.default);

process.stdout.write(canonicalize(card) + "\n");
