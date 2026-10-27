# M0–M1 security model

Each owner's gateway, policy, local private key and provider adapter are trusted
by that owner. Worker code and all received payloads are untrusted. Gateways
verify signatures against contract parties and require explicit owner receipts at
all five gates. The demo simulates owner approvals with ephemeral keys; it does
not claim an interactive human clicked an approval screen.

`subprocess_restricted` (`runSandbox` in `packages/sandbox/src/index.ts`) is a
separate OS process. The parent passes a sanitized environment (no inherited
credentials, `NODE_OPTIONS`, or `PATH`), a temporary scratch directory removed
after the task, a wall-clock timeout followed by SIGTERM then SIGKILL, and an
output byte cap. Input, output, and tool requests cross as JSON. CapGuard and
real MCP handlers stay in the gateway process. `detectNodePermissionFlag` selects
`--permission` on Node.js >= 22.13 and on Node.js 23+, or `--experimental-permission`
on earlier Node.js 20 and 22 releases. `resolveNodePermissionArgs` pairs that flag
with `--allow-fs-read` and `--allow-fs-write` for the scratch directory and does
not grant child-process, worker, or native-addon permission. If neither flag is
advertised, those `--allow-fs-*` arguments are omitted and
`ExecutionAttestation.sandboxBoundary.permissionModelActive` is false.

That permission model restricts filesystem, child processes, worker threads, and
native addons. It does not block `fetch`, `node:net`, `node:http`, `node:https`,
`node:dns`, or `node:dgram`, and it is not a kernel network namespace. Task source
is evaluated with `node:vm` in that same process. Node.js documents that `node:vm`
is not a security mechanism against untrusted code. A null-prototype context that
omits `process`, `require`, `fetch`, and `WebSocket` reduces the guest API
surface. It is not a kernel boundary. Deleting `globalThis.fetch` and `WebSocket`
in the wrapper has the same limit.

Untrusted third-party code requires `oci_container`
(`isolationLevel: 'oci_container'`). `runContainerOrSubprocessSandbox` then runs
Podman or Docker with `--network none`, `--read-only`, `--cap-drop ALL`,
`--security-opt no-new-privileges`, and PID and memory limits.
`ExecutionAttestation.effectiveIsolationLevel` is the path that actually ran.
`VerificationEngine` rejects an `oci_container` contract whose attestation is not
`oci_container` unless `sandboxPolicy.allowSubprocessFallback` is true
(`ISOLATION_LEVEL_MISMATCH`). An unavailable container runtime falls back to
`subprocess_restricted` and reports that level. A container that fails to start
is not retried in the weaker sandbox. M1 accepts the manifest's
`subprocess_restricted`, `networkAccess: none`, ephemeral-workspace policy;
unsupported isolation, network, or filesystem requests fail closed at the gateway.
Verification's deterministic checks use the same subprocess driver with tool
access denied. They are not an `oci_container` run.

BYOK credentials stay in a trusted owner-side provider adapter. Instrument it
with `meteredProvider`: usage deltas are charged before output is released, and
abort signals must be passed to provider requests. Tools reserve quota before
execution. Usage receipts attest to the gateway's measurements; they cannot prove
an independently malicious owner's honesty or recover tokens already charged by
a provider. The offline deterministic demo uses synthetic usage deltas and makes
no paid provider calls. A worker can report additional usage, but never subtract
it. A stopped run remains stopped. Signed budget amendments must be authorized
before exceeding the current budget; requester delivery verification still
requires the bilateral contract budget, so broader delivery limits require a new
bilaterally signed contract.

Capability argument schemas must be synchronous and self-contained (no `$ref`,
`$dynamicRef`, `$id`, anchors or `$async`). Child schemas must be identical or
contain the entire parent schema as a direct `allOf` conjunct. Equivalent schema
rewrites may be rejected intentionally. Scope syntax supports exact resource URIs
and terminal `/*` prefixes only. Trusted tool definitions extract the resource
from arguments; callers cannot supply an independent scope claim. A single
owner-side CapabilityGuard must be shared across tasks/proxies that consume the
same capability proofs to preserve aggregate parent counters. Counts are in-memory
for M1; persist counters before using tokens across gateway restarts.

The relay validates outer signatures, routes immutable copies and rejects repeated
envelope IDs. Gateway inboxes also pin expected sender, task and sequence so relay
replay protection is not a trust assumption. HTTP/WebSocket listeners bind only to
127.0.0.1. M1 payloads are signed plaintext: the relay is blind to credentials and
execution authority, but can observe application data. X25519 payload encryption,
remote relay authentication and durable replay storage belong to M2.

The hosted relay shards Durable Objects by recipient DID (`inbox:<did>`) and
stores agent cards on a separate `registry` object. Each accepted envelope is
one storage key plus a fixed-size meta record. Queued envelopes expire after
10 minutes; replay ids and agent cards expire after 1 hour. Defaults are
256 KiB per envelope, 256 envelopes and 4 MiB per inbox, with a per-IP rate
limit. A new deploy does not import the previous single-object snapshot.

Audit entries include a signature from each distinct party. A separate, final,
bilaterally signed checkpoint fixes the entry count and head. JSONL must end with
that checkpoint: deleting any entry or removing the checkpoint is invalid. Pin the
latest checkpoint head and expected party DIDs outside the supplied audit file
when checking for replacement or rollback to an older, legitimately signed bundle.
No offline hash chain can distinguish a complete old valid history from a current
one without such an external trust anchor. `verifyAudit` records that distinction:
`statusLabel` is `VALID (no trust anchor: truncation not checked)` when no external
anchor was supplied, while `status` stays `VALID`. `acp audit-verify` accepts
`--expect-final-state`, `--expect-last-hash`, and `--expect-entry-count` in addition
to the positional trust-anchor file. `acp_verify_audit_bundle` accepts the same three
fields. A matching anchor sets `trustAnchorVerified` and `truncationChecked`. The
verifier checks evidence integrity; it does not replay execution or certify the
truth of arbitrary event descriptions.
