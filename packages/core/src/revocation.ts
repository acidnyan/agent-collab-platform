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
  /**
   * Signature-checked notices for this target.
   * A capability notice applies only when its issuer issued that token or an
   * ancestor in the verified chain being evaluated. Another issuer's notice
   * for the same target id must not revoke that chain.
   */
  noticesFor?(targetType: 'invite' | 'capability', targetId: string): SignedRevocationNotice[];
  /**
   * True when `isRevoked` is set by a source that cannot list notice issuers.
   * A listed notice from a different issuer is not unexplained.
   */
  unexplainedRevocation?(targetType: 'invite' | 'capability', targetId: string): boolean;
}

/** Stable invite target id: JCS SHA-256 of the verified invite payload. */
export function inviteRevocationId(
  token: string,
  options: { allowPrivateRelay?: boolean } = {},
): string {
  return digest(parseAndVerifyInviteToken(token, Date.now(), options));
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

/**
 * In-memory, serializable set of verified revocation notices.
 * Capability notices are kept per issuer. A second issuer revoking the same
 * target id must not replace the first: chain checks match the notice issuer
 * to the verified token, and a colliding id is not a global kill switch.
 */
export class RevocationRegistry {
  private readonly notices = new Map<string, SignedRevocationNotice[]>();

  revoke(notice: SignedRevocationNotice, expectedIssuer?: string): void {
    if (!verifyRevocationNotice(notice, expectedIssuer)) throw new Error('INVALID_REVOCATION');
    const key = registryKey(notice.payload.targetType, notice.payload.targetId);
    const list = this.notices.get(key) ?? [];
    const duplicate = list.some(
      (existing) =>
        existing.payload.issuerDid === notice.payload.issuerDid &&
        existing.payload.revocationId === notice.payload.revocationId,
    );
    if (!duplicate) list.push(structuredClone(notice));
    this.notices.set(key, list);
  }

  isRevoked(targetType: 'invite' | 'capability', targetId: string): boolean {
    return (this.notices.get(registryKey(targetType, targetId))?.length ?? 0) > 0;
  }

  noticesFor(targetType: 'invite' | 'capability', targetId: string): SignedRevocationNotice[] {
    return (this.notices.get(registryKey(targetType, targetId)) ?? []).map((notice) =>
      structuredClone(notice),
    );
  }

  assertNotRevoked(targetType: 'invite' | 'capability', targetId: string): void {
    if (this.isRevoked(targetType, targetId)) throw new Error('TOKEN_REVOKED');
  }

  exportNotices(): SignedRevocationNotice[] {
    return [...this.notices.values()].flat().map((notice) => structuredClone(notice));
  }

  importNotices(notices: SignedRevocationNotice[]): void {
    for (const notice of notices) this.revoke(notice);
  }
}
