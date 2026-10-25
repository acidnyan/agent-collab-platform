// SPDX-License-Identifier: Apache-2.0 AND MIT
// Adapted from newtro/delegateos src/core/verification.ts (MIT), Scott Smith.
import { digest, signPayload, verifySigned, verifyEnvelope, validateOutput, verifyContract } from '@acp/core';
import type { Json, KeyPair, Signed, SignedEnvelope, TaskContract, ApprovalReceipt, UsageReceipt } from '@acp/core';
import { runSandbox } from '@acp/sandbox';
import { ApprovalGate } from './policy.js';
import { verifyUsage } from './quota.js';
export interface ContentArtifact { type: 'Artifact'; taskId: string; name: string; digest: string; data: Json }
export interface Attestation { type: 'ExecutionAttestation'; taskId: string; contractDigest: string; artifactDigest: string }
export interface Delivery { artifact: Signed<ContentArtifact>; usage: UsageReceipt; attestation: Signed<Attestation> }
export function createDelivery(taskId: string, contractDigest: string, data: Json, usage: UsageReceipt, worker: KeyPair): Delivery {
  const artifact = signPayload({ type: 'Artifact' as const, taskId, name: 'report.json', digest: digest(data), data }, worker);
  return { artifact, usage, attestation: signPayload({ type: 'ExecutionAttestation', taskId, contractDigest, artifactDigest: artifact.payload.digest }, worker) };
}
export interface VerificationResult { accepted: boolean; event: 'VERIFY_ACCEPT' | 'VERIFY_REJECT'; stages: string[]; reason?: string }
export class VerificationEngine {
  private checks = new Map<string, string>();
  registerIsolatedCheck(target: string, code: string): void { this.checks.set(target, code); }
  async verify(contract: TaskContract, envelope: SignedEnvelope, gate: ApprovalGate, approval?: ApprovalReceipt): Promise<VerificationResult> {
    const stages: string[] = [];
    try {
      if (!verifyContract(contract)) throw new Error('INVALID_CONTRACT');
      const m = contract.manifest, worker = m.worker!.ownerDid;
      if (!verifyEnvelope(envelope, m.requester.ownerDid) || envelope.payload.senderDid !== worker || envelope.payload.taskId !== m.taskId || envelope.payload.eventType !== 'DELIVER' || Date.now() > Date.parse(m.deadline)) throw new Error('CRYPTO_ENVELOPE_OR_DEADLINE');
      const d = envelope.payload.payload as unknown as Delivery;
      if (!verifySigned(d.artifact, worker) || d.artifact.payload.type !== 'Artifact' || d.artifact.payload.taskId !== m.taskId || digest(d.artifact.payload.data) !== d.artifact.payload.digest || !verifySigned(d.attestation, worker) || d.attestation.payload.type !== 'ExecutionAttestation' || d.attestation.payload.taskId !== m.taskId || d.attestation.payload.contractDigest !== contract.contractDigest || d.attestation.payload.artifactDigest !== d.artifact.payload.digest || !verifyUsage(d.usage, worker, m.taskId, m.budget)) throw new Error('CRYPTO_ARTIFACT_OR_BUDGET');
      stages.push('crypto_budget');
      if (!validateOutput(m.io.outputSchema, d.artifact.payload.data)) throw new Error('OUTPUT_SCHEMA');
      for (const check of m.verification.checks ?? []) {
        if (['json_schema', 'sha256_match', 'human_review'].includes(check.kind)) continue;
        const code = this.checks.get(check.target);
        if (check.kind !== 'deterministic_command' || !code) throw new Error('UNREGISTERED_DETERMINISTIC_CHECK');
        const result = await runSandbox({ code, input: { artifact: d.artifact.payload.data }, timeoutMs: Math.min(5000, m.budget.maxWallClockSeconds * 1000), onTool: async () => { throw new Error('VERIFICATION_TOOL_ACCESS_DENIED'); } });
        if (result !== (check.expectedExitCode ?? 0)) throw new Error('DETERMINISTIC_CHECK_FAILED');
      }
      stages.push('schema_isolated_check');
      gate.require(m.taskId, 'final_verification', d, approval);
      stages.push('owner_approval'); return { accepted: true, event: 'VERIFY_ACCEPT', stages };
    } catch (e) { return { accepted: false, event: 'VERIFY_REJECT', stages, reason: String(e) }; }
  }
}
