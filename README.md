# Forge

**ERC-8004 on-chain feedback payload generator** — middleware for the agent economy.

Forge takes an evaluation of an agent task and returns everything a client needs to
submit reputation feedback on-chain, without ever holding keys or sending transactions:

1. a canonical **ERC-8004 feedback JSON** document
2. its **keccak-256 hash** (`bytes32`)
3. the document **pinned to IPFS** (via Pinata)
4. **ABI-encoded calldata** for `ReputationRegistry.giveFeedback()`

The client signs and broadcasts the returned `contract_payload` themselves.

## Stack

Bun · Lucid Agents · x402 v2 · Coinbase CDP facilitator · Express · ethers v6

- **Network:** Base Mainnet (`eip155:8453`)
- **Price:** 0.02 USDC / call (x402 paywall)
- **Identity registry:** `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- **Reputation registry:** `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`

## Endpoint

```
POST /entrypoints/forge/invoke
Content-Type: application/json
```

### Input

```json
{
  "agent_id": "6482",
  "chain_id": 8453,
  "task": "blockchain data cleaning",
  "response_latency_ms": 1200,
  "usdc_paid": "20000",
  "tx_hash": "0xabc...",
  "success": true,
  "score": 95
}
```

| field                 | required | notes                          |
| --------------------- | -------- | ------------------------------ |
| `agent_id`            | ✅       | numeric                        |
| `score`               | ✅       | 0–100                          |
| `task`                | ✅       | non-empty                      |
| `tx_hash`             | ✅       |                                |
| `chain_id`            |          | defaults to `8453`             |
| `response_latency_ms` |          |                                |
| `usdc_paid`           |          | base units (string)            |
| `success`             |          | defaults to `false`            |

### Output

```json
{
  "feedback_hash": "0x...",
  "ipfs_uri": "ipfs://Qm...",
  "contract_payload": "0x...",
  "ready_to_sign": true
}
```

If the Pinata upload fails (or `PINATA_JWT` is unset), Forge returns
`ready_to_sign: false` with an `error` and the computed `feedback_hash`.

## Distill Standard Envelope

Every agent in the Distill ecosystem accepts an **optional** standard envelope on input and **always** returns the standard envelope on output. It applies to **both** entrypoints (`/entrypoints/forge/invoke` and `/entrypoints/trace/invoke`) and is fully backward compatible: existing (legacy) requests keep working unchanged.

### Input — envelope mode

Wrap your normal input in `payload`:

```json
{
  "distill_version": "1.0",
  "agent_id": "6482",
  "session_id": "test-session-001",
  "payload": {
    "agent_id": "6482",
    "task": "blockchain data cleaning",
    "tx_hash": "0xabc...",
    "score": 95
  }
}
```

`distill_version`, `agent_id`, and `session_id` are all optional. If `session_id` is omitted, a UUID is generated for you (`crypto.randomUUID()`).

### Input — legacy mode (backward compatible)

Send your input directly, with no wrapper — exactly as before:

```json
{
  "agent_id": "6482",
  "task": "blockchain data cleaning",
  "tx_hash": "0xabc...",
  "score": 95
}
```

### Output — always enveloped

Both input modes produce the same envelope response:

```json
{
  "distill_version": "1.0",
  "agent_id": "6482",
  "session_id": "test-session-001",
  "status": "ok",
  "output": {
    "feedback_hash": "0x...",
    "ipfs_uri": "ipfs://Qm...",
    "contract_payload": "0x...",
    "ready_to_sign": true
  },
  "processed_at": "2026-06-02T16:21:11.827Z"
}
```

| field          | notes                                                |
| -------------- | ---------------------------------------------------- |
| `status`       | `"ok"` or `"error"`                                  |
| `agent_id`     | echoed from the request, or `null` in legacy mode    |
| `session_id`   | from the request, or a generated UUID                |
| `output`       | the agent's normal output (forge or trace result)    |
| `processed_at` | ISO 8601 timestamp                                   |

> The Lucid runtime nests this envelope under the top-level `output` field of its HTTP response: `{ "run_id": "...", "status": "succeeded", "output": { ...envelope... } }`.

The envelope helpers live in `src/lib/envelope.ts` (`parseEnvelope`, `wrapResponse`, `withEnvelope`). Run `bun run test-envelope.ts` to exercise both entrypoints in both modes.

## Develop

```bash
bun install
cp .env.example .env   # fill in secrets
bun run dev            # watch mode on PORT (default 8787)
```

Smoke-test the core pipeline (no payment required):

```bash
bun run test-forge
```

## Deploy (Railway)

Set these environment variables:

```
ANTHROPIC_API_KEY=...
CDP_API_KEY_ID=...
CDP_API_KEY_SECRET=...
PRIVATE_KEY=...
PAYMENTS_RECEIVABLE_ADDRESS=0x104b5768FE505c400dd98F447665CB5c6fca388A
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
NETWORK=base
REGISTER_IDENTITY=true
AGENT_ID=6482
PINATA_JWT=        # add once you have a Pinata JWT
```
