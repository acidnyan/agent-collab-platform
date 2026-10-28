// SPDX-License-Identifier: Apache-2.0
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = Record<string, unknown>;
export interface KeyPair {
  did: string;
  privateKey: string;
}
export interface Signature {
  signerDid: string;
  canonicalization: 'RFC8785-JCS';
  payloadDigest: string;
  signedAt: string;
  signature: string;
}
export interface Signed<T> {
  payload: T;
  signature: Signature;
}
export type Gate =
  | 'contract_acceptance'
  | 'external_side_effect'
  | 'budget_increase'
  | 'redelegation'
  | 'final_verification';
export interface Approval {
  type: 'ApprovalReceipt';
  receiptId: string;
  taskId: string;
  gate: Gate;
  targetDigest: string;
  decision: 'APPROVED' | 'REJECTED';
  approvedAt: string;
}
export type ApprovalReceipt = Signed<Approval>;
export interface Usage {
  type: 'UsageReceipt';
  taskId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  wallTimeMs: number;
  halted: boolean;
}
export type UsageReceipt = Signed<Usage>;
export interface Ack {
  type: 'AckReceipt';
  taskId: string;
  entryHash: string;
  actorDid: string;
  receiverDid: string;
}
export type AckReceipt = Signed<Ack>;
/** Ciphertext wrapper stored in `envelope.payload.payload`. The relay never receives the plaintext. */
export type EncryptedEnvelopePayload = {
  __acpEncrypted: 'X25519-HKDF-AES256GCM';
  /** Ephemeral X25519 SPKI DER, or the raw 32-byte public key, base64url. */
  ephemeralPublicKey: string;
  /**
   * 12-byte AES-GCM nonce, base64url. Also the HKDF salt.
   * HKDF info binds the canonical header plus the ephemeral and recipient X25519 public keys.
   */
  iv: string;
  ciphertext: string;
  /** 16-byte AES-GCM tag, base64url. */
  tag: string;
};
export interface Envelope {
  type: 'SignedEnvelope';
  envelopeId: string;
  taskId: string;
  seq: number;
  eventType: string;
  senderDid: string;
  recipientDid: string;
  payload: Json;
}
export type SignedEnvelope = Signed<Envelope>;
export interface Capability {
  type: 'CapabilityToken';
  id: string;
  issuer: string;
  audience: string;
  taskId: string;
  resource: string;
  allowedTools: string[];
  argConstraints: Record<string, Schema>;
  maxCalls: number;
  notBefore: string;
  expiresAt: string;
  maxDepth: number;
  parentHash: string | null;
}
export type CapabilityToken = Signed<Capability>;
export interface BudgetSpec {
  costBearer: 'worker_byok' | 'bilateral_quota' | 'external_settlement_plugin';
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolInvocations: number;
  maxWallClockSeconds: number;
  onOverrun: 'hard_stop' | 'request_hitl_amendment';
}
export interface TaskManifest {
  protocolVersion: string;
  taskId: string;
  createdAt: string;
  deadline: string;
  requester: { ownerDid: string; agentDid: string; displayName?: string; relayEndpoint?: string };
  worker?: { ownerDid: string; agentDid: string; displayName?: string; relayEndpoint?: string };
  task: {
    skillId?: string;
    taskType?: string;
    title: string;
    description: string;
    acceptanceCriteria: { id: string; description: string; required: boolean }[];
  };
  io: {
    inputSchema: Schema;
    outputSchema: Schema;
    inputArtifacts?: { name: string; digest: string; mediaType: string; sizeBytes: number }[];
  };
  verification: {
    mode: string;
    requireUsageReceipt: boolean;
    requireExecutionAttestation: boolean;
    maxRetries: number;
    checks?: { checkId: string; kind: string; target: string; expectedExitCode?: number }[];
  };
  budget: BudgetSpec;
  permissions: {
    maxDelegationDepth: number;
    grantedCapabilities: {
      capabilityId: string;
      resource: string;
      allowedTools: string[];
      argConstraints?: Schema;
      maxInvocations: number;
      expiresAt: string;
    }[];
  };
  sandboxPolicy: {
    isolationLevel: string;
    networkAccess: string;
    filesystemScope: string;
    allowedHosts?: string[];
    allowSubprocessFallback?: boolean;
  };
  hitlPolicy: { requiredGates: string[] };
  signatures?: Record<string, Signature>;
}
