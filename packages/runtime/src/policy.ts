// SPDX-License-Identifier: Apache-2.0
import { verifyApproval, signApproval, digest } from '@acp/core';
import type { ApprovalReceipt, Gate, KeyPair } from '@acp/core';
export const gates: Gate[] = ['contract_acceptance', 'external_side_effect', 'budget_increase', 'redelegation', 'final_verification'];
export interface OwnerPolicy { requiredGates: Gate[]; autoApprove: Gate[] }
export class ApprovalGate {
  private used = new Set<string>();
  readonly policy: OwnerPolicy;
  constructor(readonly ownerDid: string, policy: OwnerPolicy) {
    if (policy.autoApprove.some(g => ['external_side_effect', 'budget_increase'].includes(g)) || [...policy.requiredGates, ...policy.autoApprove].some(g => !gates.includes(g))) throw new Error('INVALID_OWNER_POLICY');
    this.policy = structuredClone(policy);
  }
  require(taskId: string, gate: Gate, target: unknown, receipt?: ApprovalReceipt): ApprovalReceipt {
    if (!gates.includes(gate) || !receipt || !verifyApproval(receipt, this.ownerDid, taskId, gate, target) || this.used.has(receipt.payload.receiptId)) throw new Error('APPROVAL_REQUIRED: ' + gate);
    this.used.add(receipt.payload.receiptId); return receipt;
  }
  autoApprove(taskId: string, gate: Gate, target: unknown, owner: KeyPair): ApprovalReceipt {
    if (owner.did !== this.ownerDid || !this.policy.autoApprove.includes(gate) || this.policy.requiredGates.includes(gate)) throw new Error('HITL_REQUIRED: ' + gate);
    return signApproval(taskId, gate, target, owner);
  }
}
export function approvalTarget(taskId: string, gate: Gate, details: unknown) { return { taskId, gate, detailsDigest: digest(details) }; }
