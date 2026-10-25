// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { canonicalize, digest, generateKeyPair, resolveDid, signPayload, verifySigned, createCapability, verifyCapabilityChain, CapabilityGuard, nextState, schemaRegistry, validateSchema, signApproval, verifyApproval, signEnvelope, verifyEnvelope, validateOutput } from '../packages/core/src/index.js';
import type { CapabilityToken, State, ContractEvent } from '../packages/core/src/index.js';
const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const vectors = json('conformance/jcs-signing-vectors.json');
const attenuation = json('conformance/capability-attenuation.json');
const states = json('conformance/state-transitions.json');
const alice = generateKeyPair(), bob = generateKeyPair(), eve = generateKeyPair();
const root = createCapability({ ...attenuation.parent, audience: bob.did }, alice);
const ctx = { rootDid: alice.did, audience: eve.did, taskId: root.payload.taskId, now: Date.parse('2027-01-01T00:00:00Z') };
function child(patch: object = {}): CapabilityToken { return createCapability({ ...root.payload, maxDepth: 1, audience: eve.did, ...patch }, bob, root); }
describe('WP-1 Draft 2020-12 schemas and examples', () => {
  const registry = schemaRegistry();
  for (const f of readdirSync('spec').filter(x => x.endsWith('.schema.json'))) it('compiles ' + f, () => expect(registry.getSchema(f.slice(0, -12))).toBeTypeOf('function'));
  for (const f of readdirSync('spec/examples').filter(x => x.endsWith('.json'))) it('validates ' + f, () => expect(() => validateSchema(f.replace(/^sample-/, '').replace(/\.json$/, ''), json('spec/examples/' + f))).not.toThrow());
  it('rejects malformed signed receipts', () => expect(() => validateSchema('usage-receipt', { payload: { toolCalls: -1 } })).toThrow());
});
describe('JCS / Ed25519 / did:key conformance', () => {
  for (const [i, v] of vectors.cases.entries()) it('reproduces canonical bytes, hash and signature vector ' + i, () => {
    expect(canonicalize(v.input)).toBe(v.canonical); expect(digest(v.input)).toBe(v.digest); expect(verifySigned(v.signed)).toBe(true);
    const privateKey = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + vectors.seedHex, 'hex'), type: 'pkcs8', format: 'der' }).export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(signPayload(v.input, { did: v.signed.signature.signerDid, privateKey }, v.signed.signature.signedAt)).toEqual(v.signed);
  });
  it('uses standard Ed25519 multicodec did:key resolution', () => { expect(resolveDid(alice.did).asymmetricKeyType).toBe('ed25519'); expect(alice.did).toMatch(/^did:key:z6Mk/); });
  it.each(['did:key:z0','did:web:example.com','did:key:z11111'])('rejects malformed DID %s', did => expect(() => resolveDid(did)).toThrow());
  it.each([NaN, Infinity, undefined, new Date(), '\ud800', { field: undefined }, [undefined]])('rejects non I-JSON values', input => expect(() => canonicalize(input)).toThrow());
  it('rejects cycles', () => { const v: unknown[] = []; v.push(v); expect(() => canonicalize(v)).toThrow(); });
  it('sorts UTF-16 keys and preserves negative zero canonicalization', () => expect(canonicalize({ '\ufffd': 1, '😀': 2, z: -0 })).toBe('{"z":0,"😀":2,"�":1}'));
  it('detects payload, metadata and signer tampering', () => {
    const signed = signPayload({ value: 1 }, alice); expect(verifySigned(signed, alice.did)).toBe(true); expect(verifySigned(signed, bob.did)).toBe(false);
    const bad = structuredClone(signed); bad.payload.value++; expect(verifySigned(bad)).toBe(false);
    const time = structuredClone(signed); time.signature.signedAt = '2027-01-01T00:00:00Z'; expect(verifySigned(time)).toBe(false);
  });
  it('signs outer envelope routing metadata', () => { const e = signEnvelope({ taskId: 'task_00000000', recipientDid: bob.did, seq: 0, eventType: 'PROPOSE', payload: {} }, alice); expect(verifyEnvelope(e, bob.did)).toBe(true); e.payload.recipientDid = eve.did; expect(verifyEnvelope(e)).toBe(false); });
});
describe('monotonic capability vectors', () => {
  for (const v of attenuation.cases) it(v.name, () => {
    // Sign hostile tokens directly as a delegatee: verification must re-check
    // attenuation independently of the mint's creation-time checks.
    const hostile = signPayload({ ...root.payload, issuer: bob.did, audience: eve.did, parentHash: digest(root), id: 'child-' + v.name, ...v.patch }, bob);
    if (v.valid) { expect(() => verifyCapabilityChain([root, hostile], ctx)).not.toThrow(); expect(() => child(v.patch)).not.toThrow(); }
    else { expect(() => verifyCapabilityChain([root, hostile], ctx)).toThrow(/CAPABILITY_VIOLATION/); expect(() => child(v.patch)).toThrow(); }
  });
  it('permits explicit allOf strengthening but rejects anyOf widening', () => {
    const schema = root.payload.argConstraints['docs/read'];
    expect(() => child({ argConstraints: { 'docs/read': { allOf: [schema, { properties: { uri: { const: 'mcp://alice/docs/a' } } }] } } })).not.toThrow();
    expect(() => child({ argConstraints: { 'docs/read': { anyOf: [schema, {}] } } })).toThrow();
  });
  it('rejects depth-zero redelegation', () => { const c = child({ maxDepth: 0 }); expect(() => createCapability({ ...c.payload, audience: alice.did }, eve, c)).toThrow(/CAPABILITY_VIOLATION/); });
  it('rejects wrong trust root, task, audience, proof and signature', () => {
    const c = child();
    for (const changed of [{ rootDid: eve.did }, { audience: alice.did }, { taskId: 'task_other000' }, { now: Date.parse(root.payload.expiresAt) }, { now: 0 }]) expect(() => verifyCapabilityChain([root,c], { ...ctx, ...changed })).toThrow(/CAPABILITY_VIOLATION/);
    const tampered = structuredClone(c); tampered.payload.maxCalls++; expect(() => verifyCapabilityChain([root,tampered],ctx)).toThrow();
    const proof = signPayload({ ...c.payload, parentHash: digest({}) }, bob); expect(() => verifyCapabilityChain([root,proof],ctx)).toThrow();
  });
  it('aggregates parent call counts across siblings and revokes settled tasks', () => {
    const guard = new CapabilityGuard(); const args = { uri:'mcp://alice/docs/a' }, c = child({ maxCalls: 2 }), sibling = child({ maxCalls: 2 });
    for (const t of [c,c,sibling]) guard.authorize([root,t],ctx,'docs/read',args,args.uri);
    expect(() => guard.authorize([root,sibling],ctx,'docs/read',args,args.uri)).toThrow(/maxCalls/);
    guard.revokeTask(ctx.taskId); expect(() => guard.authorize([root,c],ctx,'docs/read',args,args.uri)).toThrow(/revoked/);
  });
  it('rejects unsafe schemas and traversal resources', () => {
    expect(() => child({ resource:'mcp://alice/docs/../private' })).toThrow();
    expect(() => child({ resource:'mcp://alice/docs/%2e%2e/private' })).toThrow();
    expect(() => child({ argConstraints:{'docs/read':{$async:true}} })).toThrow();
    expect(() => validateOutput({ $async:true }, {})).toThrow();
    expect(() => child({ argConstraints:{'docs/read':{$ref:'#'}} })).toThrow();
  });
});
describe('deterministic state transition vectors', () => {
  for (const c of states.cases) it(c.from + ' / ' + c.event, () => c.to === null ? expect(() => nextState(c.from as State,c.event as ContractEvent)).toThrow(/INVALID_STATE/) : expect(nextState(c.from,c.event)).toBe(c.to));
});
describe('owner approval signature binding', () => {
  for (const gate of ['contract_acceptance','external_side_effect','budget_increase','redelegation','final_verification'] as const) it(gate, () => {
    const receipt = signApproval(ctx.taskId,gate,{amount:1},alice);
    expect(verifyApproval(receipt,alice.did,ctx.taskId,gate,{amount:1})).toBe(true);
    expect(verifyApproval(receipt,bob.did,ctx.taskId,gate,{amount:1})).toBe(false);
    expect(verifyApproval(receipt,alice.did,ctx.taskId,gate,{amount:2})).toBe(false);
    expect(verifyApproval(receipt,alice.did,'task_other000',gate,{amount:1})).toBe(false);
  });
});
