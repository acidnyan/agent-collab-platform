// SPDX-License-Identifier: Apache-2.0
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { signApproval, signPayload, verifyApproval, digest } from '@acp/core';
import type { ApprovalReceipt, Gate, KeyPair } from '@acp/core';
import type { OwnerPolicy } from './policy.js';
export interface ApprovalRequest { taskId: string; gate: Gate; target: unknown; details?: unknown; signal?: AbortSignal }
export interface ApprovalProvider { approve(request: ApprovalRequest): Promise<ApprovalReceipt> }
export class InteractiveCliApprovalProvider implements ApprovalProvider {
  constructor(readonly owner: KeyPair, readonly options: { input?: Readable; output?: Writable } = {}) {}
  async approve(request: ApprovalRequest): Promise<ApprovalReceipt> {
    const output = this.options.output ?? process.stdout;
    output.write(JSON.stringify({ taskId: request.taskId, gate: request.gate, targetDigest: digest(request.target), target: request.target, details: request.details ?? null }, null, 2) + '\nApprove [y/N]? ');
    const rl = createInterface({ input: this.options.input ?? process.stdin, crlfDelay: Infinity });
    try {
      const answer = await new Promise<string>((resolve, reject) => {
        const abort = () => { cleanup(); reject(new Error('APPROVAL_ABORTED')); };
        const cleanup = () => request.signal?.removeEventListener('abort', abort);
        rl.once('line', line => { cleanup(); resolve(line); }); rl.once('close', () => { cleanup(); resolve(''); }); rl.once('error', e => { cleanup(); reject(e); });
        request.signal?.addEventListener('abort', abort, { once: true }); if (request.signal?.aborted) abort();
      });
      return signApproval(request.taskId, request.gate, request.target, this.owner, /^y(es)?$/i.test(answer.trim()) ? 'APPROVED' : 'REJECTED');
    } finally { rl.close(); }
  }
}
export class PolicyAutoApprovalProvider implements ApprovalProvider {
  constructor(readonly owner: KeyPair, readonly policy: OwnerPolicy = { requiredGates: [], autoApprove: ['contract_acceptance', 'final_verification'] }, readonly options: { yes?: boolean; confirmedGates?: Gate[] } = {}) {}
  async approve(r: ApprovalRequest): Promise<ApprovalReceipt> {
    const explicit = this.options.confirmedGates?.includes(r.gate);
    const sensitive = ['external_side_effect', 'budget_increase'].includes(r.gate);
    if (!explicit && (sensitive || this.policy.requiredGates.includes(r.gate) || (!this.options.yes && !this.policy.autoApprove.includes(r.gate)))) throw new Error('HITL_REQUIRED: ' + r.gate);
    return signApproval(r.taskId, r.gate, r.target, this.owner);
  }
}
export class WebhookApprovalProvider implements ApprovalProvider {
  constructor(readonly owner: KeyPair, readonly options: { url: string; ownerDid?: string; fetch?: typeof fetch; timeoutMs?: number }) {}
  async approve(r: ApprovalRequest): Promise<ApprovalReceipt> {
    const body = signPayload({ type: 'ApprovalRequest', taskId: r.taskId, gate: r.gate, target: r.target, targetDigest: digest(r.target), details: r.details ?? null }, this.owner);
    const signal = AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs ?? 60000), ...(r.signal ? [r.signal] : [])]);
    const response = await (this.options.fetch ?? fetch)(this.options.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'error' });
    if (!response.ok) throw new Error('APPROVAL_WEBHOOK_FAILED');
    const receipt = await response.json() as ApprovalReceipt;
    if (!verifyApproval(receipt, this.options.ownerDid ?? this.owner.did, r.taskId, r.gate, r.target)) throw new Error('INVALID_APPROVAL_RESPONSE'); return receipt;
  }
}
