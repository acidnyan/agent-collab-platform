// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { digest, signPayload, verifySigned } from './crypto.js';
import { parseAndVerifyInviteToken } from './discovery.js';
import type { KeyPair, Signed } from './types.js';

export interface RevocationNotice {
  type: 'RevocationNotice';
  revocationId: string;
  issuerDid: string;
  targetType: 'invite' | 'capability';
  targetId: string;
  reason: string;
  revokedAt: string;
}

export type SignedRevocationNotice = Signed<RevocationNotice>;

/** Structural view so callers can pass a registry built from another compilation of this package. */
export interface RevocationList {
  isRevoked(targetType: 'invite' | 'capability', targetId: string): boolean;
  assertNotRevoked(targetType: 'invite' | 'capability', targetId: string): void;
}

/** Stable invite target id: JCS SHA-256 of the verified invite payload. */
export function inviteRevocationId(token: string): string {
  return digest(parseAndVerifyInviteToken(token));
}

export function createRevocationNotice(
  input: {
    targetType: 'invite' | 'capability';
    targetId: string;
    reason: string;
    revokedAt?: string;
  },
  issuer: KeyPair,
): SignedRevocationNotice {
  if (input.targetType !== 'invite' && input.targetType !== 'capability')
    throw new Error('INVALID_REVOCATION');
  if (!input.targetId || !input.reason) throw new Error('INVALID_REVOCATION');
  const revokedAt = input.revokedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(revokedAt))) throw new Error('INVALID_REVOCATION');
  return signPayload(
    {
      type: 'RevocationNotice',
      revocationId: randomUUID(),
      issuerDid: issuer.did,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      revokedAt,
    },
    issuer,
  );
}

/** Ed25519 over RFC 8785 JCS. A notice signed by someone other than issuerDid is rejected. */
export function verifyRevocationNotice(
  notice: SignedRevocationNotice,
  expectedIssuer?: string,
): boolean {
  try {
    const payload = notice.payload;
    return (
      verifySigned(notice, payload.issuerDid) &&
      (!expectedIssuer || payload.issuerDid === expectedIssuer) &&
      payload.type === 'RevocationNotice' &&
      (payload.targetType === 'invite' || payload.targetType === 'capability') &&
      typeof payload.revocationId === 'string' &&
      payload.revocationId.length > 0 &&
      typeof payload.targetId === 'string' &&
      payload.targetId.length > 0 &&
      typeof payload.reason === 'string' &&
      payload.reason.length > 0 &&
      Number.isFinite(Date.parse(payload.revokedAt)) &&
      notice.signature.signerDid === payload.issuerDid
    );
  } catch {
    return false;
  }
}

function registryKey(targetType: string, targetId: string): string {
  return targetType + '\0' + targetId;
}

/** In-memory, serializable set of verified revocation notices. */
export class RevocationRegistry {
  private readonly notices = new Map<string, SignedRevocationNotice>();

  revoke(notice: SignedRevocationNotice, expectedIssuer?: string): void {
    if (!verifyRevocationNotice(notice, expectedIssuer)) throw new Error('INVALID_REVOCATION');
    this.notices.set(
      registryKey(notice.payload.targetType, notice.payload.targetId),
      structuredClone(notice),
    );
  }

  isRevoked(targetType: 'invite' | 'capability', targetId: string): boolean {
    return this.notices.has(registryKey(targetType, targetId));
  }

  assertNotRevoked(targetType: 'invite' | 'capability', targetId: string): void {
    if (this.isRevoked(targetType, targetId)) throw new Error('TOKEN_REVOKED');
  }

  exportNotices(): SignedRevocationNotice[] {
    return [...this.notices.values()].map((notice) => structuredClone(notice));
  }

  importNotices(notices: SignedRevocationNotice[]): void {
    for (const notice of notices) this.revoke(notice);
  }
}
