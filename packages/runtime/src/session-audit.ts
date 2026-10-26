// SPDX-License-Identifier: Apache-2.0
import {
  digest,
  signAck,
  signEnvelope,
  signPayload,
  validateSchema,
  verifyEnvelope,
  verifySigned,
  verifySignature,
} from '@acp/core';
import type { AckReceipt, Json, KeyPair, Signed, SignedEnvelope } from '@acp/core';
import { JsonlStore, verifyAudit } from '@acp/ledger';
import type { AuditBody, AuditBundle, AuditEntry, Checkpoint } from '@acp/ledger';
import type { RelayTransport } from '@acp/relay';
export const asJson = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;
const pause = (signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('SESSION_ABORTED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, 10);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
export async function receiveRelay(
  relay: RelayTransport,
  did: string,
  signal?: AbortSignal,
): Promise<SignedEnvelope> {
  while (true) {
    signal?.throwIfAborted();
    const e = await relay.receive(did, 1000, signal);
    if (e) return e;
    await pause(signal);
  }
}
/** Each side has only its own private key. All countersignatures arrive on wire. */
export class SessionWire {
  private outgoing = 0;
  private incoming = 0;
  readonly entries: AuditEntry[] = [];
  constructor(
    readonly relay: RelayTransport,
    readonly owner: KeyPair,
    readonly peerDid: string,
    readonly taskId: string,
    readonly actors: [string, string],
    readonly signal: AbortSignal,
    readonly auditPath?: string,
  ) {}
  async rawSend(eventType: string, payload: unknown): Promise<void> {
    await this.relay.send(
      signEnvelope(
        {
          taskId: this.taskId,
          recipientDid: this.peerDid,
          seq: this.outgoing++,
          eventType,
          payload: asJson(payload),
        },
        this.owner,
      ),
    );
  }
  private check(e: SignedEnvelope): SignedEnvelope {
    if (
      !verifyEnvelope(e, this.owner.did) ||
      e.payload.senderDid !== this.peerDid ||
      e.payload.taskId !== this.taskId ||
      e.payload.seq !== this.incoming++
    )
      throw new Error('INVALID_OR_REPLAYED_SESSION_ENVELOPE');
    if (e.payload.eventType === 'ERROR')
      throw new Error('PEER_REJECTED: ' + JSON.stringify(e.payload.payload));
    return e;
  }
  async rawReceive(expected: string | string[], initial?: SignedEnvelope): Promise<SignedEnvelope> {
    const e = this.check(initial ?? (await receiveRelay(this.relay, this.owner.did, this.signal)));
    if (!(Array.isArray(expected) ? expected : [expected]).includes(e.payload.eventType))
      throw new Error('UNEXPECTED_SESSION_EVENT: ' + e.payload.eventType);
    return e;
  }
  private append(entry: AuditEntry): void {
    validateSchema('audit-entry', entry);
    this.entries.push(entry);
    if (this.auditPath) new JsonlStore(this.auditPath).append(entry);
  }
  private body(eventType: string, payload: Json, actorDid: string, receiverDid: string): AuditBody {
    return {
      taskId: this.taskId,
      seq: this.entries.length,
      prevEntryHash: this.entries.at(-1)?.entryHash ?? null,
      actorDid,
      receiverDid,
      eventType,
      payload,
    };
  }
  async sendEvent(eventType: string, payload: unknown): Promise<void> {
    const data = asJson(payload),
      body = this.body(eventType, data, this.owner.did, this.peerDid),
      draft = signPayload(body, this.owner);
    await this.rawSend(eventType, data);
    await this.rawSend('AUDIT_ENTRY', draft);
    const ack = (await this.rawReceive('AUDIT_ACK')).payload.payload as unknown as AckReceipt;
    if (
      !verifySigned(ack, this.peerDid) ||
      ack.payload.type !== 'AckReceipt' ||
      ack.payload.taskId !== this.taskId ||
      ack.payload.actorDid !== this.owner.did ||
      ack.payload.receiverDid !== this.peerDid ||
      ack.payload.entryHash !== digest(body)
    )
      throw new Error('INVALID_AUDIT_ACK');
    this.append({
      body,
      entryHash: digest(body),
      actorSignature: draft.signature,
      counterSignature: ack,
    });
  }
  async receiveEvent(
    eventType: string | string[],
    initial?: SignedEnvelope,
  ): Promise<SignedEnvelope> {
    const e = await this.rawReceive(eventType, initial),
      signed = (await this.rawReceive('AUDIT_ENTRY')).payload
        .payload as unknown as Signed<AuditBody>;
    const expected = this.body(
      e.payload.eventType,
      e.payload.payload,
      this.peerDid,
      this.owner.did,
    );
    if (
      !verifySigned(signed, this.peerDid) ||
      digest(signed.payload) !== digest(expected) ||
      !verifySignature(expected, signed.signature, this.peerDid)
    )
      throw new Error('INVALID_AUDIT_ENTRY');
    const ack = signAck(
      {
        type: 'AckReceipt',
        taskId: this.taskId,
        entryHash: digest(expected),
        actorDid: this.peerDid,
        receiverDid: this.owner.did,
      },
      this.owner,
    );
    this.append({
      body: expected,
      entryHash: digest(expected),
      actorSignature: signed.signature,
      counterSignature: ack,
    });
    await this.rawSend('AUDIT_ACK', ack);
    return e;
  }
  private checkpoint(): Checkpoint {
    return {
      type: 'AuditCheckpoint',
      taskId: this.taskId,
      count: this.entries.length,
      head: this.entries.at(-1)?.entryHash ?? null,
      actors: this.actors,
    };
  }
  private seal(checkpoint: AuditBundle['checkpoint']): AuditBundle {
    const bundle = { entries: this.entries, checkpoint };
    if (!verifyAudit(bundle, { taskId: this.taskId, actors: this.actors }).valid)
      throw new Error('INVALID_BILATERAL_AUDIT');
    if (this.auditPath) new JsonlStore(this.auditPath).seal(checkpoint);
    return bundle;
  }
  async finishRequester(): Promise<AuditBundle> {
    const actor = signPayload(this.checkpoint(), this.owner);
    await this.rawSend('CHECKPOINT', actor);
    const receiver = (await this.rawReceive('CHECKPOINT_ACK')).payload.payload as unknown as Signed<
      Signed<Checkpoint>
    >;
    return this.seal({ actor, receiver });
  }
  async finishWorker(): Promise<AuditBundle> {
    const actor = (await this.rawReceive('CHECKPOINT')).payload
      .payload as unknown as Signed<Checkpoint>;
    if (!verifySigned(actor, this.peerDid) || digest(actor.payload) !== digest(this.checkpoint()))
      throw new Error('INVALID_AUDIT_CHECKPOINT');
    const receiver = signPayload(actor, this.owner),
      bundle = this.seal({ actor, receiver });
    await this.rawSend('CHECKPOINT_ACK', receiver);
    return bundle;
  }
}
