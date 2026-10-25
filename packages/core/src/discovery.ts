// SPDX-License-Identifier: Apache-2.0
import { signPayload, verifySigned, resolveDid } from './crypto.js';
import type { BudgetSpec, Json, KeyPair, Signed } from './types.js';
export interface AgentSkill { id: string; name: string; description?: string; inputSchema?: Json; outputSchema?: Json }
export interface DiscoveryAgentCard {
  type: 'AgentCard'; name: string; description: string; ownerDid: string; agentDid: string;
  relayEndpoint: string; skills: AgentSkill[]; costModes: BudgetSpec['costBearer'][]; version: string;
}
export type SignedAgentCard = Signed<DiscoveryAgentCard>;
function relayUrl(value: string): void { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('INVALID_RELAY_URL'); }
export function createSignedAgentCard(options: Omit<DiscoveryAgentCard, 'type' | 'ownerDid' | 'version' | 'description' | 'costModes'> & Partial<Pick<DiscoveryAgentCard, 'version' | 'description' | 'costModes'>>, owner: KeyPair): SignedAgentCard {
  const card = signPayload({ type: 'AgentCard' as const, version: '0.2.0', description: 'ACP worker', costModes: ['worker_byok'] as BudgetSpec['costBearer'][], ...options, ownerDid: owner.did }, owner);
  if (!verifySignedAgentCard(card)) throw new Error('INVALID_AGENT_CARD'); return card;
}
export function verifySignedAgentCard(card: SignedAgentCard): boolean {
  try {
    const p = card.payload; relayUrl(p.relayEndpoint); resolveDid(p.agentDid); resolveDid(p.ownerDid);
    return verifySigned(card, p.ownerDid) && p.type === 'AgentCard' && typeof p.name === 'string' && !!p.name && typeof p.description === 'string' && typeof p.version === 'string' && Array.isArray(p.skills) && p.skills.every(s => typeof s.id === 'string' && !!s.id && typeof s.name === 'string') && new Set(p.skills.map(s => s.id)).size === p.skills.length && Array.isArray(p.costModes) && p.costModes.length > 0 && p.costModes.every(m => ['worker_byok', 'bilateral_quota', 'external_settlement_plugin'].includes(m));
  } catch { return false; }
}
export function toA2AAgentCard(card: SignedAgentCard) {
  if (!verifySignedAgentCard(card)) throw new Error('INVALID_AGENT_CARD'); const p = card.payload;
  return { name: p.name, description: p.description, url: p.relayEndpoint, version: p.version, protocolVersion: '0.3.0', capabilities: { streaming: true }, defaultInputModes: ['application/json'], defaultOutputModes: ['application/json'], skills: p.skills.map(s => ({ ...s, description: s.description ?? s.name, tags: ['acp'] })), ownerDid: p.ownerDid, agentDid: p.agentDid, relayEndpoint: p.relayEndpoint, costModes: p.costModes, signedAgentCard: card };
}
export interface Invite { type: 'AgentInvite'; ownerDid: string; agentDid: string; relayUrl: string; agentCard: SignedAgentCard; issuedAt: string; expiresAt: string }
export function createInviteToken(options: { agentCard: SignedAgentCard; expiresInSeconds?: number; issuedAt?: string; format?: 'acp-invite' | 'acp' }, owner: KeyPair): string {
  if (!verifySignedAgentCard(options.agentCard) || options.agentCard.payload.ownerDid !== owner.did) throw new Error('INVALID_AGENT_CARD');
  const issuedAt = options.issuedAt ?? new Date().toISOString(), ttl = options.expiresInSeconds ?? 3600;
  if (!Number.isFinite(Date.parse(issuedAt)) || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 2592000) throw new Error('INVALID_INVITE_EXPIRY');
  const p = options.agentCard.payload;
  const token = Buffer.from(JSON.stringify(signPayload<Invite>({ type: 'AgentInvite', ownerDid: owner.did, agentDid: p.agentDid, relayUrl: p.relayEndpoint, agentCard: options.agentCard, issuedAt, expiresAt: new Date(Date.parse(issuedAt) + ttl * 1000).toISOString() }, owner))).toString('base64url');
  return options.format === 'acp' ? 'acp://invite?token=' + token : 'acp-invite:' + token;
}
export function parseAndVerifyInviteToken(uri: string, now = Date.now()): Invite {
  try {
    let token: string;
    if (uri.startsWith('acp-invite:')) token = uri.slice(11);
    else { const u = new URL(uri); if (u.protocol !== 'acp:' || u.hostname !== 'invite' || u.searchParams.getAll('token').length !== 1) throw new Error(); token = u.searchParams.get('token')!; }
    if (!/^[\w-]+$/.test(token) || token.length > 65536) throw new Error();
    const signed = JSON.parse(Buffer.from(token, 'base64url').toString()) as Signed<Invite>, p = signed.payload;
    if (!verifySigned(signed, p.ownerDid) || p.type !== 'AgentInvite' || !verifySignedAgentCard(p.agentCard) || p.agentCard.payload.ownerDid !== p.ownerDid || p.agentCard.payload.agentDid !== p.agentDid || p.agentCard.payload.relayEndpoint !== p.relayUrl || !Number.isFinite(Date.parse(p.issuedAt)) || !Number.isFinite(Date.parse(p.expiresAt)) || Date.parse(p.issuedAt) > now || Date.parse(p.expiresAt) <= now || Date.parse(p.expiresAt) <= Date.parse(p.issuedAt)) throw new Error();
    relayUrl(p.relayUrl); return p;
  } catch { throw new Error('INVALID_OR_EXPIRED_INVITE'); }
}
