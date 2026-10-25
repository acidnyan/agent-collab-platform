// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { signPayload, verifySigned } from './crypto.js';
import type { KeyPair, Signed } from './types.js';

export type RelayAuthAction = 'receive' | 'stream' | 'subscribe';
export interface RelayAuthPayload {
  type: 'RelayAuth'; recipientDid: string; action: RelayAuthAction; timestamp: string; nonce: string;
}
export function createRelayAuthToken(recipient: KeyPair, options: { action?: RelayAuthAction; now?: string; nonce?: string } = {}): string {
  const payload: RelayAuthPayload = { type: 'RelayAuth', recipientDid: recipient.did, action: options.action ?? 'receive', timestamp: options.now ?? new Date().toISOString(), nonce: options.nonce ?? randomUUID() };
  return Buffer.from(JSON.stringify(signPayload(payload, recipient))).toString('base64url');
}
export function verifyRelayAuthToken(token: string, expectedRecipientDid: string, options: { now?: number; maxSkewMs?: number } = {}): { valid: boolean; nonce?: string; action?: RelayAuthAction; error?: string } {
  try {
    if (typeof token !== 'string' || token.length > 16384 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const signed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as Signed<RelayAuthPayload>, p = signed.payload;
    const now = options.now ?? Date.now(), skew = options.maxSkewMs ?? 300000;
    if (!verifySigned(signed, expectedRecipientDid) || p.type !== 'RelayAuth' || p.recipientDid !== expectedRecipientDid || !['receive', 'stream', 'subscribe'].includes(p.action) || typeof p.nonce !== 'string' || !p.nonce.trim() || typeof p.timestamp !== 'string' || !Number.isFinite(Date.parse(p.timestamp)) || !Number.isFinite(now) || !Number.isFinite(skew) || skew < 0 || Math.abs(now - Date.parse(p.timestamp)) > skew) throw new Error();
    return { valid: true, nonce: p.nonce, action: p.action };
  } catch { return { valid: false, error: 'RELAY_UNAUTHORIZED' }; }
}
