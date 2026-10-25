# ACP conformance suite

Run `pnpm build && pnpm test` with Node 22 and pnpm 10. The suite is offline after
installation; all keys and provider usage are synthetic. `pnpm validate:schemas`
compiles every Draft 2020-12 schema and validates every JSON example.

* `jcs-signing-vectors.json`: exact UTF-8 JCS serialization, SHA-256 digest,
  synthetic Ed25519 seed, did:key and expected signed object. Metadata is signed
  with the payload; see the exact signature preimage in `spec/README.md`.
* `capability-attenuation.json`: parent bounds and child patches, including valid
  reductions and independently invalid resource, tools, schema, call count, time,
  depth and task bindings. Invalid child tokens are signed by the legitimate
  delegatee to ensure the verifier checks authority as well as authenticity.
* `state-transitions.json`: every state/event combination. A null destination
  means deterministic rejection. PROPOSE establishes PROPOSED.

The automated tests additionally cover aggregate parent usage across sibling
capabilities, signed-event replay, all five approval gates, usage receipt budget
checks, isolated verification, subprocess termination, real MCP SDK calls,
HTTP/WebSocket and in-memory relay transports, bilateral JSONL evidence and all
four executable two-owner E2E scenarios. JSONL truncation detection requires the
final signed checkpoint. Pin an external head to reject rollback to another
complete, legitimately signed bundle.

A new implementation can consume these JSON vectors without TypeScript. It must
produce the exact canonical bytes and signatures, accept the valid attenuations,
reject every invalid attenuation, and implement the same transition table.
