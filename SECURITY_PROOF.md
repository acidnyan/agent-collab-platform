# Security Proof / Red-Team Adversarial Suite

**English** | [日本語 (SECURITY_PROOF.ja.md)](./SECURITY_PROOF.ja.md)

Skeptical engineers can rerun every proof below with:

```sh
pnpm test:security-proof
```

That command is `vitest run conformance/security-proofs.test.ts`. CI runs the same step, **Run Security Proof Suite (Red-Team Adversarial Tests)**, after the main test suite. A passing run is the check: each case drives the production function, asserts the attack is rejected, and fails if a secret, injected command, cross-session read, or forged signature is accepted.

## How to read a row

| Column                | Meaning                                                              |
| --------------------- | -------------------------------------------------------------------- |
| Threat class          | The attack the proof simulates                                       |
| Architectural control | The code that is supposed to stop it                                 |
| Adversarial test      | The `describe` / `it` title in `conformance/security-proofs.test.ts` |

## Proof 1 — Memory and environment secret exfiltration

Threat class: a compromised worker task dumps `process.env`, inspects the credential broker, or redeems an expired, forged, or other-task handle, trying to recover host secrets such as `OPENAI_API_KEY` or `GITHUB_TOKEN`. This is the post-PHP2Shell memory-disclosure class named alongside `CVE-2026-109618` / `CVE-2026-109619`: raw provider material must stay in the host process.

| Threat class                            | Architectural control                                                                                                                                                                                                         | Adversarial test                                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Host env dumped by a command worker     | `sanitizedEnvironment` in `packages/sandbox/src/index.ts` builds a fresh allowlist. `CommandAgentAdapter.executeCommand` in `packages/adapters/src/command.ts` passes only that allowlist plus `PATH` and `TASK_INPUT_FILE`.  | `Proof 1: memory and environment secret exfiltration` → command worker env |
| Guest JavaScript reads `process`        | `runSandbox` in `packages/sandbox/src/index.ts` evaluates task code in a null-prototype `vm` context. The wrapper process holds Node APIs; the guest does not.                                                                | same proof → sandbox guest cannot see `process`                            |
| Real provider key vs task-scoped handle | `startCredentialProxy` in `packages/adapters/src/credential-proxy.ts` mints a random loopback token. `ClaudeCodeAdapter.executeTask` puts that token in the child env and attaches the real key only inside the host `fetch`. | same proof → credential proxy and Claude adapter                           |
| Forged, other-task, or closed handle    | The proxy compares `Authorization` / `x-api-key` to that task's token and listens only until `close()`.                                                                                                                       | same proof → forged, other-task, and closed handles                        |
| Relay error body leaks a path or token  | `sanitizeRelayErrorCode` and `mapRelayError` in `packages/relay/src/fetch.ts` return an allowlisted protocol code. `startLocalRelay` applies that filter in the Node HTTP catch and the WebSocket `message` catch. Any other exception is HTTP 500 `RELAY_INTERNAL_ERROR`. Malformed JSON and an invalid URL are HTTP 400 `INVALID_REQUEST`. | `conformance/p2-10-relay-error-sanitization.test.ts` |

## Proof 2 — Command injection and path traversal

Threat class: task input or adapter arguments contain `$(touch …)`, `` `id` ``, `; rm -rf /`, `| cat /etc/passwd`, `../../etc/passwd`, or `__proto__`.

| Threat class                      | Architectural control                                                                                                                                                                                                                     | Adversarial test                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Shell metacharacters in argv      | `runCommand` in `packages/adapters/src/command.ts` calls `spawn` without `shell: true`. Array commands are the child-process executor. `resolveCommand` rejects relative paths (`COMMAND_MUST_BE_ABSOLUTE_OR_ON_PATH`) and unknown names. | `Proof 2: command injection and path traversal` → `runCommand` and `resolveCommand` |
| Task input spliced into the shell | `CommandAgentAdapter` writes input to `workspaceDir/input.json` and the child stdin. It does not concatenate input into `argv`. A string `command` is an owner-authored `/bin/sh -c` script and still receives input only on stdin.       | same proof → adapter argv and workspace listing                                     |
| Schema and prototype pollution    | `validateOutput` in `packages/core/src/schema.ts` and `JSON.parse` as used by `parseJsonDeliverable`.                                                                                                                                     | same proof → schema and `__proto__`                                                 |

LLM CLI adapters (`claude`, `codex`, `openai`) receive untrusted input from remote peers. `ClaudeCodeAdapter` / `ClaudeCodeCliAdapter` in `packages/adapters/src/command.ts` defaults to `--tools Read,Glob,Grep`, `--disallowedTools Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch`, and `--permission-mode dontAsk`, which disables shell execution, file writes, and web tools. `CodexCliAdapter` defaults to `--sandbox read-only`. `extraArgs` or explicit adapter options replace one flag and do not emit a second copy. Operators MUST run these adapters inside an OCI container (`--isolation oci`) or restrict tasks to trusted requester DIDs (`--allow-requester <did>`). `conformance/p1-3-adapter-tool-restrictions.test.ts` locks the defaults, the override path, and the argv a mock executable actually receives (`pnpm test`).

## Proof 3 — Cross-session bleed and isolation downgrade

Threat class: concurrent principals read each other's relay inbox, a finished task leaves readable state, or a worker claims `oci_container` / `container` while the run was a subprocess (and the reverse direction of an under-reported required level). Mapped to `CVE-2026-109619` and `CVE-2026-115419`.

| Threat class                            | Architectural control                                                                                                                                                                                                                                                                           | Adversarial test                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Wrong-key inbox poll                    | `InMemoryRelay.authenticate` / `openInbox` in `packages/relay/src/fetch.ts` require a recipient-signed `RelayAuth` token from `packages/core/src/relay-auth.ts`.                                                                                                                                | `Proof 3: cross-session state bleed and isolation downgrade` → concurrent inboxes |
| `RelayAuth` replayed on another relay origin | `normalizeRelayOrigin` maps `ws:` to `http:` and `wss:` to `https:`. `HttpRelayClient`, `SseRelayClient`, and `WebSocketRelayClient` sign that origin into the token. `createRelayFetchHandler` and the local WebSocket server require it. A different origin is HTTP 401 `RELAY_AUTH_ORIGIN_MISMATCH`. A missing origin is HTTP 401 `RELAY_AUTH_ORIGIN_REQUIRED` unless `allowUnboundRelayAuth: true`. | `conformance/p2-9-relay-auth-origin.test.ts` |
| Bearer token in `?auth=`                | `extractRelayAuthToken` rejects an `auth` query parameter with HTTP 401 `RELAY_QUERY_AUTH_DISABLED` unless the relay sets `allowQueryAuth: true`. Headers `Authorization: Bearer` and `x-acp-relay-auth` stay accepted. | `conformance/p2-9-relay-auth-origin.test.ts` |
| Stale queue and envelope replay         | `receive` dequeues once. `send` rejects a repeated `envelopeId` with `REPLAYED_ENVELOPE`.                                                                                                                                                                                                       | same proof → stale queue                                                          |
| Task code picks its own isolation label | `runContainerOrSubprocessSandbox` and `SandboxAgentAdapter` in `packages/sandbox/src/container.ts` and `packages/adapters/src/sandbox.ts` set `effectiveIsolationLevel` from the runtime path. `runtime: null` falls back to `subprocess_restricted` and reports that string.                   | same proof → runner label                                                         |
| Attestation below the contract          | `VerificationEngine.verify` in `packages/runtime/src/verifier.ts` rejects an `oci_container` contract whose signed attestation is not `oci_container`, unless `sandboxPolicy.allowSubprocessFallback` is true (`ISOLATION_LEVEL_MISMATCH`). A one-byte signature flip cannot upgrade the claim. | same proof → verifier                                                             |

The requester trusts the worker's signature over the host-reported level. Untrusted task output is not that level. `packages/runtime/src/session.ts` copies `reportIsolation` into the signed attestation.

## Proof 4 — Resource exhaustion and SSRF

Threat class: oversized relay bodies, queue floods, nonce replay, and relay URLs aimed at instance metadata, loopback, or `file:`. Mapped to the exhaustion side of `CVE-2026-109618`.

| Threat class                                                              | Architectural control                                                                                                                                                                                                                                                                                                                                         | Adversarial test                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Payload over 256 KiB, queue over the per-inbox cap (default 256), or too many recipients | `InMemoryRelay.send` in `packages/relay/src/fetch.ts` rejects with `RELAY_CAPACITY` when the JSON byte length exceeds `maxEnvelopeBytes` (default `262144`), the recipient queue reaches `maxQueueSize` (default `256`), or `maxQueues` is exhausted. A per-inbox byte budget (`maxQueueBytesPerRecipient`, default 4 MiB) rejects with `QUEUE_BYTES_EXCEEDED` (HTTP 429). | `Proof 4: resource exhaustion and SSRF` → capacity |
| Nonce replay inside the retention window                                  | `authenticate` stores `recipientDid:nonce` and rejects a second use. `maxAuthSeenEntries` caps the FIFO window so the set cannot grow without bound. A nonce that is still inside the window stays rejected.                                                                                                                                                  | same proof → nonce replay                          |
| `http://169.254.169.254`, strict `http://127.0.0.1`, `file:///etc/passwd` | `validateRelayEndpointUrl` and `parseAndVerifyInviteToken` in `packages/core/src/discovery.ts`. Link-local, metadata, and unspecified hosts always throw `SSRF_BLOCKED_RELAY_URL`. Loopback and other private ranges throw by default and when `allowPrivateRelay: false`. `file:` is not an allowed protocol. `RequesterClient.delegate` calls the same check before dialing, and Node clients pin the socket to the validated addresses (`packages/runtime/src/session.ts`). | same proof → SSRF                                  |
| Provider URL `file:///etc/passwd`                                         | `startCredentialProxy` rejects non-HTTP(S) base URLs with `INVALID_PROVIDER_URL`.                                                                                                                                                                                                                                                                             | same proof → provider URL                          |

Public `http:` and `ws:` relay endpoints stay allowed. `conformance/security-hardening.test.ts` (`accepts public http: endpoints`) locks that policy. This proof does not claim cleartext public HTTP is blocked.

`AcpMcpServer` in `packages/runtime/src/mcp-server.ts` applies the same outbound boundary to MCP hosts such as Claude Desktop or Cursor. `acp_delegate_task` and `acp_delegate_multi` parse invite tokens locally. Before any dial they reject a worker DID outside `allowedWorkerDids` with `MCP_WORKER_NOT_ALLOWED`, and a relay URL outside `allowedRelayUrls` with `MCP_RELAY_NOT_ALLOWED`. A plain worker DID must be listed. An invite matches when either `agentDid` or `ownerDid` is listed. Relay URLs from the configured relay, tool arguments, and invite tokens are normalized to origin plus pathname with no trailing slash. A configured relay is not replaced unless `allowAnyRelay` is set or the new URL is allowlisted. `approvalWebhookUrl` posts `{ taskId, summaryHash, reason, approverDid }` and signs the owner decision only when the webhook returns `{ approved: true }`. `{ approved: false }` and non-2xx responses throw `APPROVAL_REJECTED` before task input is sent. The tool descriptions state that input is transmitted externally. `conformance/p1-7-mcp-outbound-policy.test.ts` locks these checks (`pnpm test`).

## Proof 5 — Envelope and artifact tampering

Threat class: one-byte or one-field edits to a signed `TaskContract` budget or scope, an artifact hash / `UsageReceipt`, or a `RelayAuth` timestamp or signature. Canonicalization is RFC 8785 JCS and the signature algorithm is Ed25519 (`packages/core/src/crypto.ts`).

| Threat class                                            | Architectural control                                                                                                                                                                                           | Adversarial test                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Budget or scope edited after signing                    | `verifyContract` in `packages/core/src/contract.ts` requires `digest(manifest) === digest(proposal.payload)` and a valid Ed25519 signature over the JCS payload.                                                | `Proof 5: cryptographic envelope and artifact tampering` → contract |
| Artifact bytes or `digest` edited; usage receipt edited | `VerificationEngine.verify` requires `verifySigned` on the artifact, attestation, and usage receipt, and `digest(data) === artifact.payload.digest`. The signed artifact is the task receipt this suite checks. | same proof → artifact and usage                                     |
| Stale or flipped `RelayAuth`                            | `verifyRelayAuthToken` rejects timestamps outside five minutes of skew and any signature byte that no longer verifies.                                                                                          | same proof → RelayAuth                                              |

An unmodified contract, delivery, and fresh token are accepted first. A verifier that rejected everything would fail those controls.

## Proof 9 — End-to-end payload encryption

Threat class: a curious or compromised relay operator reads task inputs, `CapabilityToken`s, or task results from queued envelopes or a storage snapshot. A third party who copies a ciphertext, or moves it onto another `taskId` or `seq`, tries to decrypt it.

| Threat class                                           | Architectural control                                                                                                                                                                                                                       | Adversarial test                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Relay reads a saved session payload                    | `SessionWire` in `packages/runtime/src/session-audit.ts` encrypts every payload to the peer `did:key`. `encryptEnvelopePayload` in `packages/core/src/crypto.ts` uses a fresh X25519 key, HKDF-SHA256, and AES-256-GCM bound to the header. | `Proof 9: end-to-end payload encryption` → hides task input, capability tokens, and results from the relay |
| Third party decrypts an intercepted envelope           | Only the recipient seed derives the X25519 scalar. `decryptEnvelopePayload` throws `ENVELOPE_DECRYPTION_FAILED`.                                                                                                                            | same proof → rejects a third party and a ciphertext moved to another header                                |
| Ciphertext transplanted onto another `taskId` or `seq` | The GCM additional data and the HKDF info are the canonical header (`taskId`, `seq`, `eventType`, `senderDid`, `recipientDid`).                                                                                                             | same proof → transplanted header                                                                           |
| Cleartext session envelope accepted without E2EE       | `decryptEnvelopePayload` defaults `requireEncrypted` to true and throws `UNENCRYPTED_ENVELOPE_REJECTED`. `WorkerNode`, `RequesterClient`, and `VerificationEngine` use that default. `{ requireEncrypted: false }` or `allowUnencryptedEnvelopes: true` is an explicit legacy opt-out. | same proof → legacy cleartext envelope, and `P1-8 require encrypted envelopes`                             |

The outer Ed25519 signature still covers the ciphertext, so the relay checks envelope shape without a decryption key. `decryptEnvelopePayload`, `WorkerNode`, `RequesterClient`, and `VerificationEngine` require encrypted envelopes (`requireEncrypted: true`) by default and reject a cleartext session envelope with `UNENCRYPTED_ENVELOPE_REJECTED`. A caller opens cleartext only by passing `{ requireEncrypted: false }` or `allowUnencryptedEnvelopes: true`, for a legacy in-memory fixture. Routing metadata remains visible.

## Proof 10 — Token revocation and live cancellation

Threat class: a stolen invite or capability is presented after the issuer revokes it; a third party forges a `RevocationNotice`; a requester must stop a running sandbox without leaving an unsigned hole in the audit log.

| Threat class                                      | Architectural control                                                                                                                                                                      | Adversarial test                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Revoked invite presented at `PROPOSE`             | `WorkerNode` calls `RevocationRegistry.assertNotRevoked` on the invite URI and its JCS digest before `ACCEPT`.                                                                            | `Proof 10: token revocation and live cancellation` → revoked invites                                     |
| Revoked capability presented to a tool            | `CapabilityGuard.authorize` throws `TOKEN_REVOKED` before `MCPProxy` calls the backend.                                                                                                   | same proof → revoked capabilities                                                                         |
| `RevocationNotice` signed by a non-issuer         | `verifyRevocationNotice` requires the Ed25519 signer to be `issuerDid`. `revoke(notice, expectedIssuer)` rejects a mismatch with `INVALID_REVOCATION`.                                  | same proof → forged notice                                                                                |
| Requester aborts a running sandbox                | `CANCEL` is signed, encrypted, and countersigned. The worker aborts the task and signals the child `SIGTERM`, then `SIGKILL`. The sealed log contains `CANCEL` and verifies as `VALID`. | same proof → cancels a running sandbox                                                                   |

## Proof 11 — Encrypted progress and Byzantine quorum

Threat class: a relay reads a `PROGRESS` message; a compromised worker returns a verified but poisoned deliverable and tries to become the result.

| Threat class                                      | Architectural control                                                                                                                                                          | Adversarial test                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Relay reads a progress frame                      | `PROGRESS` uses `SessionWire` payload encryption. The event type stays visible. The message does not appear in the serialized envelope.                                       | `Proof 11: encrypted progress and Byzantine quorum` → keeps PROGRESS plaintext off the relay             |
| One worker returns a different verified output    | `delegateMulti({ mode: 'quorum' })` groups outputs by RFC 8785 JCS SHA-256. The matching honest digest wins. Every verified receipt, including the minority, is retained.    | same proof → outvotes a poisoned worker                                                                   |

## Local verification

From a built checkout (Node.js 22, pnpm 10):

```sh
pnpm test:security-proof
```

Expect every test in `conformance/security-proofs.test.ts` to pass. The full regression suite remains `pnpm test`.
