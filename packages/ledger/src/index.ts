// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from 'node:fs';
import {
  digest,
  signPayload,
  signAck,
  verifySigned,
  verifySignature,
  validateSchema,
} from '@acp/core';
import type { Json, Signature, AckReceipt, KeyPair, Signed } from '@acp/core';
export interface AuditBody {
  taskId: string;
  seq: number;
  prevEntryHash: string | null;
  actorDid: string;
  receiverDid: string;
  eventType: string;
  payload: Json;
}
export interface AuditEntry {
  body: AuditBody;
  entryHash: string;
  actorSignature: Signature;
  counterSignature: AckReceipt;
}
export interface Checkpoint {
  type: 'AuditCheckpoint';
  taskId: string;
  count: number;
  head: string | null;
  actors: [string, string];
}
export interface AuditBundle {
  entries: AuditEntry[];
  checkpoint: { actor: Signed<Checkpoint>; receiver: Signed<Signed<Checkpoint>> };
}
export interface AuditStore {
  read(): AuditEntry[];
  append(entry: AuditEntry, checkpoint: AuditBundle['checkpoint']): void;
  seal?(checkpoint: AuditBundle['checkpoint']): void;
}
export class MemoryStore implements AuditStore {
  #entries: AuditEntry[] = [];
  read(): AuditEntry[] {
    return structuredClone(this.#entries);
  }
  append(entry: AuditEntry): void {
    this.#entries.push(structuredClone(entry));
  }
}
export class JsonlStore implements AuditStore {
  constructor(readonly path: string) {}
  private records(): { entry?: AuditEntry; checkpoint?: AuditBundle['checkpoint'] }[] {
    try {
      return readFileSync(this.path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }
  read(): AuditEntry[] {
    return this.records()
      .filter((r) => r.entry)
      .map((r) => r.entry!);
  }
  append(entry: AuditEntry): void {
    if (this.records().some((r) => r.checkpoint)) throw new Error('LEDGER_SEALED');
    appendFileSync(this.path, JSON.stringify({ entry }) + '\n', { mode: 0o600 });
  }
  seal(checkpoint: AuditBundle['checkpoint']): void {
    const old = this.records().at(-1)?.checkpoint;
    if (old) {
      if (digest(old.actor.payload) !== digest(checkpoint.actor.payload))
        throw new Error('LEDGER_SEALED');
      return;
    }
    appendFileSync(this.path, JSON.stringify({ checkpoint }) + '\n', { mode: 0o600 });
  }
}
export function parseJsonl(text: string): AuditBundle {
  const records = text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { entry?: AuditEntry; checkpoint?: AuditBundle['checkpoint'] });
  const last = records.pop();
  if (!last?.checkpoint || last.entry || records.some((r) => !r.entry || r.checkpoint))
    throw new Error('MISSING_OR_MISPLACED_CHECKPOINT');
  return { entries: records.map((r) => r.entry!), checkpoint: last.checkpoint };
}
export class BilateralLedger {
  constructor(
    readonly taskId: string,
    readonly actors: [string, string],
    readonly store: AuditStore = new MemoryStore(),
  ) {
    if (actors[0] === actors[1]) throw new Error('DISTINCT_ACTORS_REQUIRED');
  }
  private checkpoint(
    entries: AuditEntry[],
    actor: KeyPair,
    receiver: KeyPair,
  ): AuditBundle['checkpoint'] {
    const payload: Checkpoint = {
      type: 'AuditCheckpoint',
      taskId: this.taskId,
      count: entries.length,
      head: entries.at(-1)?.entryHash ?? null,
      actors: this.actors,
    };
    const signed = signPayload(payload, actor);
    return { actor: signed, receiver: signPayload(signed, receiver) };
  }
  append(eventType: string, payload: Json, actor: KeyPair, receiver: KeyPair): AuditEntry {
    if (
      actor.did === receiver.did ||
      !this.actors.includes(actor.did) ||
      !this.actors.includes(receiver.did)
    )
      throw new Error('INVALID_LEDGER_PARTIES');
    const entries = this.store.read();
    if (!verifyAudit({ entries, checkpoint: this.checkpoint(entries, actor, receiver) }).valid)
      throw new Error('CORRUPT_EXISTING_LEDGER');
    const body: AuditBody = {
      taskId: this.taskId,
      seq: entries.length,
      prevEntryHash: entries.at(-1)?.entryHash ?? null,
      actorDid: actor.did,
      receiverDid: receiver.did,
      eventType,
      payload,
    };
    const entryHash = digest(body),
      actorSignature = signPayload(body, actor).signature;
    const counterSignature = signAck(
      {
        type: 'AckReceipt',
        taskId: this.taskId,
        entryHash,
        actorDid: actor.did,
        receiverDid: receiver.did,
      },
      receiver,
    );
    const entry = { body, entryHash, actorSignature, counterSignature };
    validateSchema('audit-entry', entry);
    this.store.append(entry, this.checkpoint([...entries, entry], actor, receiver));
    return entry;
  }
  bundle(actor: KeyPair, receiver: KeyPair): AuditBundle {
    const entries = this.store.read();
    const checkpoint = this.checkpoint(entries, actor, receiver);
    this.store.seal?.(checkpoint);
    return { entries, checkpoint };
  }
}
/** External pin for the bilateral checkpoint. `head` is the checkpoint head. */
export interface AuditTrustAnchor {
  taskId?: string;
  actors?: [string, string];
  head?: string;
  expectedFinalState?: string;
  expectedLastEntryHash?: string;
  expectedEntryCount?: number;
}
export interface AuditVerificationOptions extends AuditTrustAnchor {
  trustAnchor?: AuditTrustAnchor;
}
export interface AuditVerificationResult {
  valid: boolean;
  status: 'VALID' | 'INVALID';
  statusLabel: string;
  trustAnchorVerified: boolean;
  truncationChecked: boolean;
  reason?: string;
}
/**
 * Intact chain with no external anchor. A hash chain cannot tell a complete
 * older log from the current one, so tail truncation is not checked.
 */
export const AUDIT_VALID_WITHOUT_TRUST_ANCHOR =
  'VALID (no trust anchor: truncation not checked)';
function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function textField(primary: string | undefined, fallback: string | undefined): string | undefined {
  if (hasText(primary)) return primary;
  if (hasText(fallback)) return fallback;
  return undefined;
}
function anchorSupplied(options?: AuditVerificationOptions): boolean {
  if (!options) return false;
  return [options, options.trustAnchor].some((part) => {
    if (!part) return false;
    return (
      part.taskId !== undefined ||
      part.actors !== undefined ||
      hasText(part.head) ||
      hasText(part.expectedFinalState) ||
      hasText(part.expectedLastEntryHash) ||
      typeof part.expectedEntryCount === 'number'
    );
  });
}
function sameAnchorField(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return true;
  return digest(left) === digest(right);
}
function resolveAnchor(options?: AuditVerificationOptions): AuditTrustAnchor {
  const nested = options?.trustAnchor;
  if (
    options &&
    nested &&
    (!sameAnchorField(options.taskId, nested.taskId) ||
      !sameAnchorField(options.actors, nested.actors) ||
      !sameAnchorField(options.head, nested.head) ||
      !sameAnchorField(options.expectedFinalState, nested.expectedFinalState) ||
      !sameAnchorField(options.expectedLastEntryHash, nested.expectedLastEntryHash) ||
      !sameAnchorField(options.expectedEntryCount, nested.expectedEntryCount))
  )
    throw new Error('trust anchor');
  return {
    taskId: options?.taskId ?? nested?.taskId,
    actors: options?.actors ?? nested?.actors,
    head: textField(options?.head, nested?.head),
    expectedFinalState: textField(options?.expectedFinalState, nested?.expectedFinalState),
    expectedLastEntryHash: textField(options?.expectedLastEntryHash, nested?.expectedLastEntryHash),
    expectedEntryCount: options?.expectedEntryCount ?? nested?.expectedEntryCount,
  };
}
function assertTrustAnchor(
  anchor: AuditTrustAnchor,
  checkpoint: Checkpoint,
  entries: AuditEntry[],
): void {
  if (anchor.taskId !== undefined && anchor.taskId !== checkpoint.taskId)
    throw new Error('trust anchor');
  if (anchor.actors !== undefined) {
    if (
      !Array.isArray(anchor.actors) ||
      anchor.actors.length !== 2 ||
      digest(anchor.actors) !== digest(checkpoint.actors)
    )
      throw new Error('trust anchor');
  }
  const last = entries.at(-1)?.entryHash ?? null;
  if (anchor.head !== undefined && anchor.head !== checkpoint.head) throw new Error('trust anchor');
  if (anchor.expectedLastEntryHash !== undefined && anchor.expectedLastEntryHash !== last)
    throw new Error('trust anchor');
  if (anchor.expectedEntryCount !== undefined) {
    if (
      typeof anchor.expectedEntryCount !== 'number' ||
      !Number.isSafeInteger(anchor.expectedEntryCount) ||
      anchor.expectedEntryCount < 0 ||
      anchor.expectedEntryCount !== checkpoint.count
    )
      throw new Error('trust anchor');
  }
  if (
    anchor.expectedFinalState !== undefined &&
    entries.at(-1)?.body.eventType !== anchor.expectedFinalState
  )
    throw new Error('trust anchor');
}
function auditResult(supplied: boolean, error?: unknown): AuditVerificationResult {
  if (error !== undefined)
    return {
      valid: false,
      status: 'INVALID',
      statusLabel: 'INVALID',
      trustAnchorVerified: false,
      truncationChecked: supplied,
      reason: String(error),
    };
  if (!supplied)
    return {
      valid: true,
      status: 'VALID',
      statusLabel: AUDIT_VALID_WITHOUT_TRUST_ANCHOR,
      trustAnchorVerified: false,
      truncationChecked: false,
    };
  return {
    valid: true,
    status: 'VALID',
    statusLabel: 'VALID',
    trustAnchorVerified: true,
    truncationChecked: true,
  };
}
export function verifyAudit(
  bundle: AuditBundle,
  expected?: AuditVerificationOptions,
): AuditVerificationResult {
  const supplied = anchorSupplied(expected);
  try {
    const { entries, checkpoint } = bundle,
      c = checkpoint.actor.payload;
    const selfDelegated = Array.isArray(c?.actors) && c.actors.length === 2 && c.actors[0] === c.actors[1];
    if (
      c.type !== 'AuditCheckpoint' ||
      c.actors.length !== 2 ||
      !c.actors.includes(checkpoint.actor.signature.signerDid) ||
      !c.actors.includes(checkpoint.receiver.signature.signerDid) ||
      (!selfDelegated &&
        checkpoint.actor.signature.signerDid === checkpoint.receiver.signature.signerDid) ||
      !verifySigned(checkpoint.actor) ||
      !verifySigned(checkpoint.receiver) ||
      digest(checkpoint.receiver.payload) !== digest(checkpoint.actor) ||
      c.count !== entries.length ||
      c.head !== (entries.at(-1)?.entryHash ?? null)
    )
      throw new Error('checkpoint');
    assertTrustAnchor(resolveAnchor(expected), c, entries);
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i],
        b = e.body,
        a = e.counterSignature;
      validateSchema('audit-entry', e);
      if (
        b.taskId !== c.taskId ||
        b.seq !== i ||
        b.prevEntryHash !== (entries[i - 1]?.entryHash ?? null) ||
        e.entryHash !== digest(b) ||
        !c.actors.includes(b.actorDid) ||
        !c.actors.includes(b.receiverDid) ||
        (!selfDelegated && b.actorDid === b.receiverDid) ||
        !verifySignature(b, e.actorSignature, b.actorDid) ||
        !verifySigned(a, b.receiverDid) ||
        a.payload.entryHash !== e.entryHash ||
        a.payload.taskId !== b.taskId ||
        a.payload.actorDid !== b.actorDid ||
        a.payload.receiverDid !== b.receiverDid
      )
        throw new Error('entry ' + i);
    }
    return auditResult(supplied);
  } catch (e) {
    return auditResult(supplied, e);
  }
}
