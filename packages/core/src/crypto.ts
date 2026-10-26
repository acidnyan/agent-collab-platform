// SPDX-License-Identifier: Apache-2.0 AND MIT
// Adapted from newtro/delegateos src/core/crypto.ts (MIT), Scott Smith.
// ACP uses Node Ed25519, SHA-256 and did:key; it is not DelegateOS SJT wire format.
import {
  createHash,
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  sign,
  verify,
} from 'node:crypto';
import canonicalizeJson from 'canonicalize';
import type { KeyPair, Signature, Signed } from './types.js';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes: Uint8Array): string {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let s = '';
  while (n) {
    s = alphabet[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}
function unbase58(s: string): Buffer {
  if (!s || s.length > 128) throw new Error('INVALID_DID');
  let n = 0n;
  for (const c of s) {
    const i = alphabet.indexOf(c);
    if (i < 0) throw new Error('INVALID_DID');
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.concat([
    Buffer.alloc(s.match(/^1*/)?.[0].length ?? 0),
    n ? Buffer.from(hex, 'hex') : Buffer.alloc(0),
  ]);
}
function assertJson(v: unknown, seen = new Set<object>()): void {
  if (v === null || typeof v === 'boolean') return;
  if (typeof v === 'string') {
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v))
      throw new Error('INVALID_UNICODE');
    return;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return;
  if (typeof v !== 'object' || seen.has(v)) throw new Error('INVALID_JSON');
  if (
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) !== Object.prototype &&
    Object.getPrototypeOf(v) !== null
  )
    throw new Error('INVALID_JSON');
  seen.add(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) assertJson(v[i], seen);
  } else
    for (const [k, x] of Object.entries(v)) {
      assertJson(k);
      assertJson(x, seen);
    }
  seen.delete(v);
}
export function canonicalize(v: unknown): string {
  assertJson(v);
  const s = (canonicalizeJson as unknown as (v: unknown) => string | undefined)(v);
  if (s === undefined) throw new Error('INVALID_JSON');
  return s;
}
export function digestBytes(v: string | Uint8Array): string {
  return 'sha256:' + createHash('sha256').update(v).digest('hex');
}
export function digest(v: unknown): string {
  return digestBytes(canonicalize(v));
}
export function generateKeyPair(): KeyPair {
  const kp = generateKeyPairSync('ed25519');
  const raw = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    did: 'did:key:z' + base58(Buffer.concat([Buffer.from([0xed, 0x01]), raw])),
    privateKey: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
export function resolveDid(did: string) {
  if (!did.startsWith('did:key:z')) throw new Error('INVALID_DID');
  const raw = unbase58(did.slice(9));
  if (raw.length !== 34 || raw[0] !== 0xed || raw[1] !== 1 || base58(raw) !== did.slice(9))
    throw new Error('INVALID_DID');
  return createPublicKey({
    format: 'der',
    type: 'spki',
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw.subarray(2)]),
  });
}
export function signPayload<T>(
  payload: T,
  key: KeyPair,
  signedAt = new Date().toISOString(),
): Signed<T> {
  const payloadDigest = digest(payload);
  const metadata = {
    signerDid: key.did,
    canonicalization: 'RFC8785-JCS' as const,
    payloadDigest,
    signedAt,
  };
  // Metadata is covered as well as the payload, preventing signer/time substitution.
  const signature =
    'ed25519:' +
    sign(
      null,
      Buffer.from(canonicalize({ payload, ...metadata })),
      createPrivateKey(key.privateKey),
    ).toString('base64url');
  const result = { payload: structuredClone(payload), signature: { ...metadata, signature } };
  if (!verifySigned(result, key.did)) throw new Error('KEY_DID_MISMATCH');
  return result;
}
export function verifySigned<T>(value: Signed<T>, expectedDid?: string): boolean {
  try {
    const { signature, ...metadata } = value.signature;
    return (
      (!expectedDid || metadata.signerDid === expectedDid) &&
      metadata.canonicalization === 'RFC8785-JCS' &&
      Number.isFinite(Date.parse(metadata.signedAt)) &&
      metadata.payloadDigest === digest(value.payload) &&
      /^ed25519:[A-Za-z0-9_-]{86}$/.test(signature) &&
      verify(
        null,
        Buffer.from(canonicalize({ payload: value.payload, ...metadata })),
        resolveDid(metadata.signerDid),
        Buffer.from(signature.slice(8), 'base64url'),
      )
    );
  } catch {
    return false;
  }
}
export function verifySignature(
  payload: unknown,
  signature: Signature,
  expectedDid?: string,
): boolean {
  return verifySigned({ payload, signature }, expectedDid);
}
