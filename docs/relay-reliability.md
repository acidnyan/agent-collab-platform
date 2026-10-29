# Relay reliability

**English** | [日本語](./relay-reliability.ja.md)

## Request deadlines and retries

The Node HTTP relay transport disables keep-alive and pins every connection to the validated DNS addresses. Requests have a 45-second overall deadline (including the response body) and a 35-second socket idle timeout. DNS resolution is also bounded. SSE keeps the idle timeout but releases the overall deadline after stream headers arrive. Library callers can set `requestTimeoutMs` and `socketTimeoutMs` in `RelayClientSecurityOptions`. A timeout has code `ETIMEDOUT`. Successful DNS pins and security failures remain cached; transient DNS failures may resolve again, with the same address validation.

Worker and requester polling retry transient network errors and HTTP 429/502/503/504. Backoff starts at 125–250 ms, doubles, and caps at 15–30 seconds with jitter. Each failed attempt logs a metadata-only retry notice. Cancellation interrupts backoff. Authentication, validation, SSRF and other permanent failures still fail immediately. HTTP registration uses the same deadline and makes at most five attempts. Sends are not automatically retried, because an uncertain POST may already have been accepted.

## HTTP lease and acknowledgement protocol

`GET /envelopes?recipient=<did>&lease=true` (also `/inbox/<did>`) opts into a 30-second visibility lease. The envelope remains queued and counts against all existing limits. Unacknowledged envelopes become visible after the lease expires, until the original ten-minute TTL expires. Durable Objects persist the lease; restarting the object does not remove it. Requests without `lease=true`, SSE, and WebSocket clients retain their existing destructive fetch behavior. Peek does not acquire or extend a lease.

After persistence or processing, acknowledge with `DELETE /envelopes/<envelopeId>?recipient=<did>` and a fresh recipient-bound RelayAuth token for the `receive` action. The existing response is 204 when removed, or 404 when already absent. The HTTP client treats either as acknowledgement success. A different recipient cannot read or delete another inbox. Acknowledgement does not remove the envelope replay record or weaken signature, sequence, timestamp, or authentication nonce checks.

Runtime HTTP polling opts into leases. `HttpRelayClient.receive` callers outside the runtime opt in using `{ lease: true }` and call `acknowledgeDelivery` themselves. The client verifies every fetched envelope before suppressing duplicates by recipient and envelope ID. It remembers deliveries for ten minutes, with a 16,384-entry cap, and retries acknowledgements of completed deliveries when redelivered. A full deduplication cache fails closed.

Workers with `--inbox` append an `envelopeId` field to each accepted record, flush the file to disk, then acknowledge the proposal. On restart, recorded envelope IDs prevent a second inbox append or task execution for the same proposal. Old records without this field remain readable. A failed persistence leaves the proposal unacknowledged. Without `--inbox`, a proposal is acknowledged after adapter execution succeeds. Session events are acknowledged after audit processing; control receipts are acknowledged when consumed. Relays or transports without the acknowledgement capability retain their previous runtime behavior.

The existing `--on-receive` hook remains a best-effort notification after persistence. Delivery durability comes from the inbox, not from hook completion. This protocol does not provide exactly-once external side effects or resume an interrupted bilateral session. A crash before persistence permits redelivery; after persistence the inbox is the recovery source. No automatic deployment of the hosted relay is performed by this change.
