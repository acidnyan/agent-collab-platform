// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from 'node:fs';
import { digest, signPayload, signAck, verifySigned, verifySignature, validateSchema } from '@acp/core';
import type { Json, Signature, AckReceipt, KeyPair, Signed } from '@acp/core';
export interface AuditBody { taskId: string; seq: number; prevEntryHash: string | null; actorDid: string; receiverDid: string; eventType: string; payload: Json }
export interface AuditEntry { body: AuditBody; entryHash: string; actorSignature: Signature; counterSignature: AckReceipt }
export interface Checkpoint { type: 'AuditCheckpoint'; taskId: string; count: number; head: string | null; actors: [string, string] }
export interface AuditBundle { entries: AuditEntry[]; checkpoint: { actor: Signed<Checkpoint>; receiver: Signed<Signed<Checkpoint>> } }
export interface AuditStore { read(): AuditEntry[]; append(entry: AuditEntry, checkpoint: AuditBundle['checkpoint']): void; seal?(checkpoint: AuditBundle['checkpoint']): void }
export class MemoryStore implements AuditStore {
  #entries: AuditEntry[] = [];
  read(): AuditEntry[] { return structuredClone(this.#entries); }
  append(entry: AuditEntry): void { this.#entries.push(structuredClone(entry)); }
}
export class JsonlStore implements AuditStore {
  constructor(readonly path: string) {}
  private records(): { entry?: AuditEntry; checkpoint?: AuditBundle['checkpoint'] }[] {
    try { return readFileSync(this.path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  }
  read(): AuditEntry[] { return this.records().filter(r => r.entry).map(r => r.entry!); }
  append(entry: AuditEntry): void {
    if (this.records().some(r => r.checkpoint)) throw new Error('LEDGER_SEALED');
    appendFileSync(this.path, JSON.stringify({ entry }) + '\n', { mode: 0o600 });
  }
  seal(checkpoint: AuditBundle['checkpoint']): void {
    const old = this.records().at(-1)?.checkpoint;
    if (old) { if (digest(old.actor.payload) !== digest(checkpoint.actor.payload)) throw new Error('LEDGER_SEALED'); return; }
    appendFileSync(this.path, JSON.stringify({ checkpoint }) + '\n', { mode: 0o600 });
  }
}
export function parseJsonl(text: string): AuditBundle {
  const records = text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { entry?: AuditEntry; checkpoint?: AuditBundle['checkpoint'] });
  const last = records.pop(); if (!last?.checkpoint || last.entry || records.some(r => !r.entry || r.checkpoint)) throw new Error('MISSING_OR_MISPLACED_CHECKPOINT');
  return { entries: records.map(r => r.entry!), checkpoint: last.checkpoint };
}
export class BilateralLedger {
  constructor(readonly taskId: string, readonly actors: [string, string], readonly store: AuditStore = new MemoryStore()) { if (actors[0] === actors[1]) throw new Error('DISTINCT_ACTORS_REQUIRED'); }
  private checkpoint(entries: AuditEntry[], actor: KeyPair, receiver: KeyPair): AuditBundle['checkpoint'] {
    const payload: Checkpoint = { type: 'AuditCheckpoint', taskId: this.taskId, count: entries.length, head: entries.at(-1)?.entryHash ?? null, actors: this.actors };
    const signed = signPayload(payload, actor); return { actor: signed, receiver: signPayload(signed, receiver) };
  }
  append(eventType: string, payload: Json, actor: KeyPair, receiver: KeyPair): AuditEntry {
    if (actor.did === receiver.did || !this.actors.includes(actor.did) || !this.actors.includes(receiver.did)) throw new Error('INVALID_LEDGER_PARTIES');
    const entries = this.store.read();
    if (!verifyAudit({ entries, checkpoint: this.checkpoint(entries, actor, receiver) }).valid) throw new Error('CORRUPT_EXISTING_LEDGER');
    const body: AuditBody = { taskId: this.taskId, seq: entries.length, prevEntryHash: entries.at(-1)?.entryHash ?? null, actorDid: actor.did, receiverDid: receiver.did, eventType, payload };
    const entryHash = digest(body), actorSignature = signPayload(body, actor).signature;
    const counterSignature = signAck({ type: 'AckReceipt', taskId: this.taskId, entryHash, actorDid: actor.did, receiverDid: receiver.did }, receiver);
    const entry = { body, entryHash, actorSignature, counterSignature }; validateSchema('audit-entry', entry);
    this.store.append(entry, this.checkpoint([...entries, entry], actor, receiver)); return entry;
  }
  bundle(actor: KeyPair, receiver: KeyPair): AuditBundle { const entries = this.store.read(); const checkpoint = this.checkpoint(entries, actor, receiver); this.store.seal?.(checkpoint); return { entries, checkpoint }; }
}
export function verifyAudit(bundle: AuditBundle, expected?: { taskId: string; actors: [string, string]; head?: string }): { valid: boolean; status: 'VALID' | 'INVALID'; reason?: string } {
  try {
    const { entries, checkpoint } = bundle, c = checkpoint.actor.payload;
    if (c.type !== 'AuditCheckpoint' || c.actors.length !== 2 || c.actors[0] === c.actors[1] || !c.actors.includes(checkpoint.actor.signature.signerDid) || !c.actors.includes(checkpoint.receiver.signature.signerDid) || checkpoint.actor.signature.signerDid === checkpoint.receiver.signature.signerDid || !verifySigned(checkpoint.actor) || !verifySigned(checkpoint.receiver) || digest(checkpoint.receiver.payload) !== digest(checkpoint.actor) || c.count !== entries.length || c.head !== (entries.at(-1)?.entryHash ?? null)) throw new Error('checkpoint');
    if (expected && (expected.taskId !== c.taskId || digest(expected.actors) !== digest(c.actors) || (expected.head && expected.head !== c.head))) throw new Error('trust anchor');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i], b = e.body, a = e.counterSignature;
      validateSchema('audit-entry', e);
      if (b.taskId !== c.taskId || b.seq !== i || b.prevEntryHash !== (entries[i - 1]?.entryHash ?? null) || e.entryHash !== digest(b) || !c.actors.includes(b.actorDid) || !c.actors.includes(b.receiverDid) || b.actorDid === b.receiverDid || !verifySignature(b, e.actorSignature, b.actorDid) || !verifySigned(a, b.receiverDid) || a.payload.entryHash !== e.entryHash || a.payload.taskId !== b.taskId || a.payload.actorDid !== b.actorDid || a.payload.receiverDid !== b.receiverDid) throw new Error('entry ' + i);
    }
    return { valid: true, status: 'VALID' };
  } catch (e) { return { valid: false, status: 'INVALID', reason: String(e) }; }
}
