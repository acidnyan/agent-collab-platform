// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  CapabilityGuard,
  createCapability,
  createRevocationNotice,
  digest,
  generateKeyPair,
  RevocationRegistry,
  signPayload,
  verifySignature,
  verifySigned,
} from '../packages/core/src/index.js';
import type { Signed } from '../packages/core/src/index.js';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function alternateSignature<T>(value: Signed<T>, unusedBits = 1): Signed<T> {
  const copy = structuredClone(value);
  const signature = copy.signature.signature;
  const last = alphabet.indexOf(signature.at(-1)!);
  copy.signature.signature = signature.slice(0, -1) + alphabet[(last & 48) | unusedBits];
  expect(copy.signature.signature).not.toBe(signature);
  expect(Buffer.from(copy.signature.signature.slice(8), 'base64url')).toEqual(
    Buffer.from(signature.slice(8), 'base64url'),
  );
  return copy;
}

function fixture() {
  const issuer = generateKeyPair(),
    worker = generateKeyPair();
  const now = Date.parse('2027-01-01T00:00:00Z');
  const context = {
    rootDid: issuer.did,
    audience: worker.did,
    taskId: 'task_signature_encoding',
    now,
  };
  const token = createCapability(
    {
      audience: worker.did,
      taskId: context.taskId,
      resource: 'data://local/item',
      allowedTools: ['read'],
      argConstraints: { read: {} },
      maxCalls: 1,
      maxDepth: 0,
      notBefore: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString(),
    },
    issuer,
  );
  return { issuer, context, token };
}

describe('signature encoding validation', () => {
  it('rejects non-canonical unused bits through both shared verifier entry points', () => {
    const { issuer, token } = fixture();
    expect(verifySigned(token, issuer.did)).toBe(true);
    expect(verifySignature(token.payload, token.signature, issuer.did)).toBe(true);
    for (let unusedBits = 1; unusedBits < 16; unusedBits++) {
      const alternate = alternateSignature(token, unusedBits);
      expect(alternate.signature.signature).toMatch(/^ed25519:[A-Za-z0-9_-]{86}$/);
      expect(verifySigned(alternate, issuer.did)).toBe(false);
      expect(verifySignature(alternate.payload, alternate.signature, issuer.did)).toBe(false);
    }
  });

  it.each([
    ['padding', (encoded: string) => encoded + '=='],
    ['whitespace', (encoded: string) => encoded.slice(0, 10) + ' \n' + encoded.slice(10)],
    ['63 bytes', () => Buffer.alloc(63).toString('base64url')],
    ['65 bytes', () => Buffer.alloc(65).toString('base64url')],
  ] as const)('rejects signature encoding with %s', (_name, encode) => {
    const { issuer, token } = fixture();
    token.signature.signature = 'ed25519:' + encode(token.signature.signature.slice(8));
    expect(verifySigned(token, issuer.did)).toBe(false);
    expect(verifySignature(token.payload, token.signature, issuer.did)).toBe(false);
  });

  it('preserves the capability call limit across equivalent signature encodings', () => {
    const { context, token } = fixture();
    const guard = new CapabilityGuard();
    const alternate = alternateSignature(token);
    guard.authorize([token], context, 'read', {}, 'data://local/item');
    expect(() => guard.authorize([alternate], context, 'read', {}, 'data://local/item')).toThrow(
      'CAPABILITY_VIOLATION: signature, task or time',
    );
    expect(() => guard.authorize([token], context, 'read', {}, 'data://local/item')).toThrow(
      'maxCalls exhausted',
    );
  });

  it('shares capability call counters by signed identity across signing metadata', () => {
    const { issuer, context, token } = fixture();
    const guard = new CapabilityGuard();
    const resigned = signPayload(token.payload, issuer, '2027-01-01T00:00:01Z');
    expect(verifySigned(resigned, issuer.did)).toBe(true);
    expect(digest(resigned)).not.toBe(digest(token));
    guard.authorize([token], context, 'read', {}, 'data://local/item');
    expect(() => guard.authorize([resigned], context, 'read', {}, 'data://local/item')).toThrow(
      'maxCalls exhausted',
    );
  });

  it('scopes capability call counters to the issuer of the signed id', () => {
    const { context, token } = fixture();
    const otherIssuer = generateKeyPair();
    const otherToken = signPayload({ ...token.payload, issuer: otherIssuer.did }, otherIssuer);
    const guard = new CapabilityGuard();
    guard.authorize([token], context, 'read', {}, 'data://local/item');
    expect(() =>
      guard.authorize(
        [otherToken],
        { ...context, rootDid: otherIssuer.did },
        'read',
        {},
        'data://local/item',
      ),
    ).not.toThrow();
  });

  it('preserves independent counters in a requester-generated two-token chain', () => {
    const { issuer, context, token } = fixture();
    const root = createCapability(
      { ...token.payload, audience: issuer.did, maxCalls: 2, maxDepth: 1 },
      issuer,
    );
    const leaf = createCapability(
      { ...root.payload, audience: context.audience, maxDepth: 0 },
      issuer,
      root,
    );
    expect(root.payload.id).not.toBe(leaf.payload.id);
    const guard = new CapabilityGuard();
    for (let i = 0; i < 2; i++)
      guard.authorize([root, leaf], context, 'read', {}, 'data://local/item');
    expect(() => guard.authorize([root, leaf], context, 'read', {}, 'data://local/item')).toThrow(
      'maxCalls exhausted',
    );
  });

  it.each(['id', 'digest'] as const)(
    'enforces capability revocation by %s across equivalent signature encodings',
    (target) => {
      const { issuer, context, token } = fixture();
      const registry = new RevocationRegistry();
      registry.revoke(
        createRevocationNotice(
          {
            targetType: 'capability',
            targetId: target === 'id' ? token.payload.id : digest(token),
            reason: 'capability lifecycle validation',
          },
          issuer,
        ),
      );
      const guard = new CapabilityGuard(registry);
      expect(() => guard.authorize([token], context, 'read', {}, 'data://local/item')).toThrow(
        'TOKEN_REVOKED',
      );
      expect(() =>
        guard.authorize([alternateSignature(token)], context, 'read', {}, 'data://local/item'),
      ).toThrow('CAPABILITY_VIOLATION: signature, task or time');
      if (target === 'id') {
        const resigned = signPayload(token.payload, issuer, '2027-01-01T00:00:01Z');
        expect(() => guard.authorize([resigned], context, 'read', {}, 'data://local/item')).toThrow(
          'TOKEN_REVOKED',
        );
      }
    },
  );
});
