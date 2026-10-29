// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import QRCode from 'qrcode';
import { createInviteToken, createSignedAgentCard, parseAndVerifyInviteToken, signPayload, verifySigned } from '@acp/core';
import type { Invite, KeyPair, Signed } from '@acp/core';
import { addContact, contactsPath } from './contacts.js';

export function inviteToken(value: string): string {
  if (value.startsWith('acp-invite:')) return value;
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.search ||
      !/^#acp-invite:[A-Za-z0-9_-]+$/.test(u.hash)) throw new Error('INVALID_INVITE_LINK');
  return u.hash.slice(1);
}
export function openInvite(value: string, now = Date.now()): Invite {
  return parseAndVerifyInviteToken(inviteToken(value), now);
}
export function shareLink(token: string, host: string): string {
  openInvite(token);
  const u = new URL(host);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
    throw new Error('INVALID_SHARE_HOST');
  u.hash = inviteToken(token);
  return u.href;
}
/** The QR contains exactly the verified link; no remote shortening or QR service. */
export async function renderInviteQr(link: string, format: 'terminal' | 'svg' | 'png'): Promise<string | Buffer> {
  openInvite(link);
  try {
    if (format === 'png') return await QRCode.toBuffer(link, { errorCorrectionLevel: 'L', margin: 4 });
    return await QRCode.toString(link, { type: format, errorCorrectionLevel: 'L', margin: 4 });
  } catch { throw new Error('QR_CAPACITY_EXCEEDED: share the full link instead; no truncated QR was created'); }
}
export function verifiedExpiredInvite(value: string): Invite {
  const token = inviteToken(value);
  let issuedAt: string;
  try { issuedAt = JSON.parse(Buffer.from(token.slice(11), 'base64url').toString()).payload.issuedAt; }
  catch { throw new Error('INVALID_INVITE'); }
  const time = Date.parse(issuedAt);
  if (!Number.isFinite(time) || time > Date.now()) throw new Error('INVALID_INVITE');
  return parseAndVerifyInviteToken(token, time);
}
export function reissueInvite(value: string, key: KeyPair, seconds = 86400): string {
  const old = verifiedExpiredInvite(value);
  if (old.ownerDid !== key.did || old.agentDid !== key.did) throw new Error('INVITE_ISSUER_KEY_REQUIRED');
  const { type: _type, ownerDid: _owner, agentDelegation: _delegation, ...card } = old.agentCard.payload;
  return createInviteToken({ agentCard: createSignedAgentCard({ ...card,
    expiresAt: new Date(Date.now() + seconds * 1000).toISOString() }, key), expiresInSeconds: seconds }, key);
}
interface ReissueRequest { type: 'InviteReissueRequest'; requesterDid: string; issuerDid: string; createdAt: string; }
async function confirm(message: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { if ((await rl.question(message + ' Type yes: ')).trim() !== 'yes') throw new Error('APPROVAL_REJECTED'); }
  finally { rl.close(); }
}
export async function inviteShareCommand(action: string, args: string[]): Promise<void> {
  const allowed = ['--file', '--host', '--png', '--svg', '--save-contact', '--key', '--contacts', '--out', '--request'];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || flags.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--'))
      throw new Error('INVALID_INVITE_OPTION: automatic approval is not supported');
    flags.set(args[i], args[i + 1]);
  }
  const need = (name: string) => { const v = flags.get('--' + name); if (!v) throw new Error('Missing --' + name); return v; };
  const value = readFileSync(need('file'), 'utf8').trim();
  if (action === 'open') {
    const p = openInvite(value);
    console.log(JSON.stringify({ name: p.agentCard.payload.name, ownerDid: p.ownerDid, agentDid: p.agentDid,
      relay: p.relayUrl, expires: new Date(Math.min(Date.parse(p.expiresAt), Date.parse(p.agentCard.payload.expiresAt))).toUTCString(),
      approval: 'Opening an invite does not approve work or allow automatic acceptance.' }));
    if (flags.has('--save-contact')) {
      const key = JSON.parse(readFileSync(need('key'), 'utf8')) as KeyPair;
      addContact(flags.get('--contacts') ?? contactsPath(), key, inviteToken(value), need('save-contact'));
    }
  } else if (action === 'share') {
    const link = shareLink(value, need('host'));
    console.log(link);
    console.log(await renderInviteQr(link, 'terminal'));
    for (const type of ['png', 'svg'] as const) if (flags.has('--' + type))
      writeFileSync(need(type), await renderInviteQr(link, type), { flag: 'wx', mode: 0o600 });
  } else if (action === 'request-reissue') {
    const old = verifiedExpiredInvite(value);
    const key = JSON.parse(readFileSync(need('key'), 'utf8')) as KeyPair;
    const request = signPayload<ReissueRequest>({ type: 'InviteReissueRequest', requesterDid: key.did,
      issuerDid: old.ownerDid, createdAt: new Date().toISOString() }, key);
    writeFileSync(need('out'), JSON.stringify(request), { flag: 'wx', mode: 0o600 });
    console.log('Re-issue request saved. Send it to the issuer for approval.');
  } else if (action === 'reissue') {
    const key = JSON.parse(readFileSync(need('key'), 'utf8')) as KeyPair;
    if (flags.has('--request')) {
      const r = JSON.parse(readFileSync(need('request'), 'utf8')) as Signed<ReissueRequest>;
      if (!verifySigned(r, r.payload.requesterDid) || r.payload.type !== 'InviteReissueRequest' ||
          r.payload.issuerDid !== key.did || !Number.isFinite(Date.parse(r.payload.createdAt)) ||
          Math.abs(Date.now() - Date.parse(r.payload.createdAt)) > 86400000) throw new Error('INVALID_REISSUE_REQUEST');
      await confirm('Approve re-issue requested by ' + r.payload.requesterDid + '?');
    } else await confirm('Approve a fresh 24-hour invite for the same identity?');
    writeFileSync(need('out'), reissueInvite(value, key), { flag: 'wx', mode: 0o600 });
    console.log('Fresh invite saved. Previous invite retains its own expiry/revocation.');
  } else throw new Error('INVALID_INVITE_ACTION');
}
