# Relay reliability

**English** | [日本語](./relay-reliability.ja.md)

## Request deadlines and retries

The Node HTTP relay transport disables keep-alive and pins every connection to the validated DNS addresses. Requests have a 45-second overall deadline (including the response body) and a 35-second socket idle timeout. DNS resolution is also bounded. SSE keeps the idle timeout but releases the overall deadline after stream headers arrive. Library callers can set `requestTimeoutMs` and `socketTimeoutMs` in `RelayClientSecurityOptions`. A timeout has code `ETIMEDOUT`. Successful DNS pins and security failures remain cached; transient DNS failures may resolve again, with the same address validation.

Worker and requester polling retry transient network errors and HTTP 429/502/503/504. Backoff starts at 125–250 ms, doubles, and caps at 15–30 seconds with jitter. Each failed attempt logs a metadata-only retry notice. Cancellation interrupts backoff. Authentication, validation, SSRF and other permanent failures still fail immediately. HTTP registration uses the same deadline and makes at most five attempts. Sends are not automatically retried, because an uncertain POST may already have been accepted.

## HTTP lease and acknowledgement protocol

`GET /envelopes?recipient=<did>&lease=true` (also `/inbox/<did>`) opts into a 30-second visibility lease. The envelope remains queued and counts against all existing limits. Unacknowledged envelopes become visible after the lease expires, until the original ten-minute TTL expires. Durable Objects persist the lease; restarting the object does not remove it. Requests without `lease=true` and WebSocket clients retain their existing destructive fetch behavior. `SseRelayClient` now requests leases; raw `/stream` requests without `lease=true` retain destructive delivery. Peek does not acquire or extend a lease.

After persistence or processing, acknowledge with `DELETE /envelopes/<envelopeId>?recipient=<did>` and a fresh recipient-bound RelayAuth token for the `receive` action. The existing response is 204 when removed, or 404 when already absent. The HTTP client treats either as acknowledgement success. A different recipient cannot read or delete another inbox. Acknowledgement does not remove the envelope replay record or weaken signature, sequence, timestamp, or authentication nonce checks.

Runtime HTTP polling opts into leases. `HttpRelayClient.receive` callers outside the runtime opt in using `{ lease: true }` and call `acknowledgeDelivery` themselves. The client verifies every fetched envelope before suppressing duplicates by recipient and envelope ID. It remembers deliveries for ten minutes, with a 16,384-entry cap, and retries acknowledgements of completed deliveries when redelivered. A full deduplication cache fails closed.

Workers with `--inbox` append an `envelopeId` field to each accepted record, flush the file to disk, then acknowledge the proposal. On restart, recorded envelope IDs prevent a second inbox append or task execution for the same proposal. Old records without this field remain readable. A failed persistence leaves the proposal unacknowledged. Without `--inbox`, a proposal is acknowledged after adapter execution succeeds. Session events are acknowledged after audit processing; control receipts are acknowledged when consumed. Relays or transports without the acknowledgement capability retain their previous runtime behavior.

The existing `--on-receive` hook remains a best-effort notification after persistence. Delivery durability comes from the inbox, not from hook completion. This protocol does not provide exactly-once external side effects or resume an interrupted bilateral session. A crash before persistence permits redelivery; after persistence the inbox is the recovery source. No automatic deployment of the hosted relay is performed by this change.

## Listener supervision and liveness

`WorkerNode.start()` and `worker start` supervise inbox reads, including reads while a task runs. A dropped connection retries with the jittered backoff above; successful reads refresh authentication. Status callbacks (`WorkerNodeOptions.onStatus`) and CLI stderr report `connected`, `reconnecting`, `unavailable`, or `stopped`. HTTP 401/403 and invalid signed envelopes stop the listener and fail its active task mailboxes. Restarting a listener never reruns an adapter or approves a contract. Persistent task checkpoints retain their existing restart/reconciliation behavior.

`SseRelayClient` reconnects after EOF, connection resets, and classified transient errors, with a new signed credential on each connection. Its default connection timeout is 45 seconds and byte-idle timeout is 35 seconds; relay stream comments arrive every 15 seconds. Stop/abort interrupts reads and backoff. Terminal authentication or verification failures stay terminal. SSE receive filters are preserved on reconnect. The client requests `lease=true` and resumes by envelope ID and explicit acknowledgement, rather than treating the last parsed SSE frame as processed. Buffered frames survive reconnect; a frame lost before parsing is redelivered after its visibility lease expires. Completed deliveries are deduplicated and their lost acknowledgements retried. This requires a relay supporting the lease/DELETE protocol; a legacy destructive-only stream cannot guarantee redelivery.

During execution, workers send signed, encrypted `HEARTBEAT` envelopes (default every 15 seconds). The requester checks the peer identity, task, timestamp, and signature before refreshing its idle watchdog. Heartbeats have their own liveness semantics and do not add audit entries, change session sequence numbers, reset approval waits, extend task deadlines, or amend the agreed budget. Replayed or stale heartbeats cannot keep a peer alive. A peer idle timeout reports `PEER_IDLE_TIMEOUT`; a terminal relay status is reported directly, for example `RELAY_REJECTED: 401`. The shared requester inbox closes every attached task on a terminal transport failure and stops polling. Diagnostics omit HTTP response bodies and arbitrary transport text. CLI and MCP callers receive the same errors.

## Task timeout controls

There is no implicit two-minute absolute session cap. `delegate --help` and `worker start --help` list these options; all values are positive integer **milliseconds**, at most 2147483647:

| CLI flag | Library option | Default | Meaning |
| --- | --- | --- | --- |
| `--execution-timeout-ms` | `executionTimeoutMs` | Delegate: existing 60000 ms contract budget; worker: agreed budget | AI/adapter execution ceiling. Delegate proposes this limit as `budget.maxWallClockSeconds`, rounded down to whole seconds (minimum 1000 ms). A supplied manifest must fit the explicit limit. |
| `--task-timeout-ms` | `taskTimeoutMs` | 600000 ms (10 minutes) | Absolute task limit, including approval and settlement. Generated manifests use this deadline; an earlier supplied manifest deadline always wins. |
| `--wait-timeout-ms` | `waitTimeoutMs` | 600000 ms | Maximum time in each peer/owner approval wait phase: proposal/accept/start and delivery/verification/settlement. Authenticated activity does not reset this timer. |
| `--connect-timeout-ms` | `connectTimeoutMs` | 45000 ms | Bound each relay request/connection, including injected transports. Transient failures retry until cancellation or the task deadline. |
| `--transport-idle-timeout-ms` | `transportIdleTimeoutMs` | 90000 ms | Requester watchdog for authenticated peer activity during execution, independent of execution quota. |
| `--heartbeat-interval-ms` | `heartbeatIntervalMs` | 15000 ms | Worker heartbeat interval. On the requester this validates the expected cadence; configure the actual worker separately. Must be below the idle timeout. Workers also check the requesting peer's idle requirement before acceptance. |

These options are accepted by `delegate` and `worker start`, and by `DelegateOptions` / `RequesterClientOptions` / `WorkerNodeOptions`. MCP single and multi delegation accept the camelCase options. Multi delegation forwards the controls to every task. The existing library `timeoutMs` remains an alias for the overall limit; `taskTimeoutMs` takes precedence. An idle worker waiting for a new proposal is not subject to the per-task or approval-wait timers; owner stop still interrupts it.

An explicit execution limit above an explicit overall limit is rejected before a proposal is sent. Workers reject a proposed wall-clock budget exceeding their explicit execution or overall cap before `ACCEPT`. The execution quota and manifest deadline remain authoritative even with regular heartbeats or progress; budget increases still require the existing owner approval flow. Set execution, overall, and wait limits on both peers to accommodate longer tasks and human approvals. Timeouts report `EXECUTION_TIMEOUT`, `TASK_TIMEOUT`, or `PEER_WAIT_TIMEOUT` as appropriate; they never authorize a retry of uncertain task execution.

For example, to propose a five-minute execution budget with ten minutes for approvals and settlement, add `--execution-timeout-ms 300000 --task-timeout-ms 600000 --wait-timeout-ms 600000` to `delegate`. Configure the worker with compatible limits. Increasing `--wait-timeout-ms` alone does not extend the overall deadline.
