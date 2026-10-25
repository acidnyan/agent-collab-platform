// SPDX-License-Identifier: Apache-2.0 AND MIT
// Adapted from newtro/delegateos src/core/contract.ts (MIT), Scott Smith.
import { digest, signPayload, verifySigned } from './crypto.js';
import { validateManifest } from './schema.js';
import type { KeyPair, Signed, TaskManifest } from './types.js';
export interface TaskContract { manifest: TaskManifest; proposal: Signed<TaskManifest>; acceptance: Signed<{ type: 'ACCEPT'; manifestDigest: string; taskId: string }>; contractDigest: string }
export function createContract(manifest: TaskManifest, proposal: Signed<TaskManifest>, worker: KeyPair): TaskContract {
  validateManifest(manifest);
  if (!manifest.worker || worker.did !== manifest.worker.ownerDid || digest(manifest) !== digest(proposal.payload) || !verifySigned(proposal, manifest.requester.ownerDid)) throw new Error('INVALID_CONTRACT');
  const acceptance = signPayload({ type: 'ACCEPT' as const, manifestDigest: digest(manifest), taskId: manifest.taskId }, worker);
  return { manifest: structuredClone(manifest), proposal, acceptance, contractDigest: digest({ proposal, acceptance }) };
}
export function verifyContract(c: TaskContract): boolean {
  try { validateManifest(c.manifest); return !!c.manifest.worker && digest(c.manifest) === digest(c.proposal.payload) && verifySigned(c.proposal, c.manifest.requester.ownerDid) && verifySigned(c.acceptance, c.manifest.worker.ownerDid) && c.acceptance.payload.type === 'ACCEPT' && c.acceptance.payload.taskId === c.manifest.taskId && c.acceptance.payload.manifestDigest === digest(c.manifest) && c.contractDigest === digest({ proposal: c.proposal, acceptance: c.acceptance }); } catch { return false; }
}
export type State = 'PROPOSED' | 'ACCEPTED' | 'IN_PROGRESS' | 'DELIVERED' | 'VERIFY_ACCEPT' | 'VERIFY_REJECT' | 'SETTLED' | 'CANCELLED' | 'DISPUTED';
export type ContractEvent = 'ACCEPT' | 'START' | 'DELIVER' | 'VERIFY_ACCEPT' | 'VERIFY_REJECT' | 'SETTLE' | 'CANCEL' | 'DISPUTE';
export const transitions: Partial<Record<State, Partial<Record<ContractEvent, State>>>> = {
  PROPOSED: { ACCEPT: 'ACCEPTED', CANCEL: 'CANCELLED' }, ACCEPTED: { START: 'IN_PROGRESS', CANCEL: 'CANCELLED' },
  IN_PROGRESS: { DELIVER: 'DELIVERED', CANCEL: 'CANCELLED' }, DELIVERED: { VERIFY_ACCEPT: 'VERIFY_ACCEPT', VERIFY_REJECT: 'VERIFY_REJECT', DISPUTE: 'DISPUTED' },
  VERIFY_ACCEPT: { SETTLE: 'SETTLED' }, VERIFY_REJECT: { DISPUTE: 'DISPUTED', CANCEL: 'CANCELLED' }, DISPUTED: { SETTLE: 'SETTLED' }
};
export function nextState(state: State, event: ContractEvent): State { const next = transitions[state]?.[event]; if (!next) throw new Error('INVALID_STATE_TRANSITION'); return next; }
export interface Transition { taskId: string; contractDigest: string; seq: number; from: State; event: ContractEvent }
export class ContractMachine {
  #state: State = 'PROPOSED'; #seq = 0; readonly history: Signed<Transition>[] = [];
  get state(): State { return this.#state; }
  constructor(readonly contract: TaskContract) { if (!verifyContract(contract)) throw new Error('INVALID_CONTRACT'); }
  event(event: ContractEvent, key: KeyPair): Signed<Transition> { return signPayload({ taskId: this.contract.manifest.taskId, contractDigest: this.contract.contractDigest, seq: this.#seq, from: this.#state, event }, key); }
  apply(signed: Signed<Transition>): State {
    const p = signed.payload, m = this.contract.manifest;
    const workerEvents = ['ACCEPT', 'START', 'DELIVER'];
    const expected = workerEvents.includes(p.event) ? m.worker!.ownerDid : m.requester.ownerDid;
    const either = ['CANCEL', 'DISPUTE'].includes(p.event);
    if (!verifySigned(signed) || (!either && signed.signature.signerDid !== expected) || (either && ![m.requester.ownerDid, m.worker!.ownerDid].includes(signed.signature.signerDid)) || p.taskId !== m.taskId || p.contractDigest !== this.contract.contractDigest || p.seq !== this.#seq || p.from !== this.#state) throw new Error('INVALID_TRANSITION_SIGNATURE');
    this.#state = nextState(this.#state, p.event); this.#seq++; this.history.push(structuredClone(signed)); return this.#state;
  }
}
