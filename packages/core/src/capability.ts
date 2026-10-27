// SPDX-License-Identifier: Apache-2.0 AND MIT
// Adapted from newtro/delegateos src/core/dct.ts and chain.ts (MIT), Scott Smith.
import { randomUUID } from 'node:crypto';
import { canonicalize, digest, signPayload, verifySigned } from './crypto.js';
import { validateSchema, createAjv, assertSynchronousSchema } from './schema.js';
import type { RevocationList } from './revocation.js';
import type { Capability, CapabilityToken, KeyPair, Schema } from './types.js';
export function violation(detail: string): never {
  throw new Error('CAPABILITY_VIOLATION: ' + detail);
}
// Only exact URIs and terminal /* prefixes are supported. No glob inference.
export function resourceWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  if (!parent.endsWith('/*')) return false;
  const prefix = parent.slice(0, -1);
  return (
    child.startsWith(prefix) &&
    !child.slice(prefix.length).includes('..') &&
    !/%2e|%2f|%5c/i.test(child) &&
    !child.includes('\\')
  );
}
// General JSON Schema containment is undecidable. Accept identical schemas or
// explicit allOf inheritance only; reject all other rewrites, including equivalent ones.
function assertToolSchema(schema: Schema): void {
  assertSynchronousSchema(schema);
  const check = (s: unknown): void => {
    if (!s || typeof s !== 'object') return;
    for (const [k, v] of Object.entries(s)) {
      if (['$ref', '$dynamicRef', '$id', '$anchor', '$dynamicAnchor'].includes(k))
        violation('tool schemas must be self-contained');
      check(v);
    }
  };
  check(schema);
  createAjv().compile(schema);
}
export function schemaNarrows(child: Schema, parent: Schema): boolean {
  if (canonicalize(child) === canonicalize(parent)) return true;
  return (
    Array.isArray(child.allOf) &&
    child.allOf.some((s: Schema) => canonicalize(s) === canonicalize(parent))
  );
}
export function assertAttenuation(parent: CapabilityToken, child: CapabilityToken): void {
  const p = parent.payload,
    c = child.payload;
  if (
    c.parentHash !== digest(parent) ||
    p.audience !== c.issuer ||
    p.taskId !== c.taskId ||
    c.maxDepth > p.maxDepth - 1 ||
    c.maxCalls > p.maxCalls ||
    Date.parse(c.expiresAt) > Date.parse(p.expiresAt) ||
    Date.parse(c.notBefore) < Date.parse(p.notBefore) ||
    !resourceWithin(c.resource, p.resource)
  )
    violation('non-monotonic delegation');
  for (const tool of c.allowedTools)
    if (
      !p.allowedTools.includes(tool) ||
      !c.argConstraints[tool] ||
      !p.argConstraints[tool] ||
      !schemaNarrows(c.argConstraints[tool], p.argConstraints[tool])
    )
      violation('tool or argument schema escalation');
}
export function createCapability(
  params: Omit<Capability, 'type' | 'id' | 'issuer' | 'parentHash'>,
  key: KeyPair,
  parent?: CapabilityToken,
): CapabilityToken {
  const token = signPayload(
    {
      ...params,
      type: 'CapabilityToken' as const,
      id: randomUUID(),
      issuer: key.did,
      parentHash: parent ? digest(parent) : null,
    },
    key,
  );
  validateSchema('capability-token', token);
  for (const tool of token.payload.allowedTools)
    if (
      !token.payload.argConstraints[tool] ||
      !createAjv().validateSchema(token.payload.argConstraints[tool])
    )
      violation('missing or invalid tool schema');
  for (const tool of token.payload.allowedTools)
    assertToolSchema(token.payload.argConstraints[tool]);
  if (parent) assertAttenuation(parent, token);
  return token;
}
export interface CapabilityContext {
  rootDid: string;
  audience: string;
  taskId: string;
  now?: number;
}
export function verifyCapabilityChain(
  chain: CapabilityToken[],
  context: CapabilityContext,
): CapabilityToken {
  if (!chain.length || chain.length > 32) violation('invalid proof chain length');
  for (let i = 0; i < chain.length; i++) {
    const t = chain[i],
      p = t.payload;
    try {
      validateSchema('capability-token', t);
    } catch {
      violation('malformed token');
    }
    if (
      !verifySigned(t, p.issuer) ||
      p.taskId !== context.taskId ||
      (context.now ?? Date.now()) < Date.parse(p.notBefore) ||
      (context.now ?? Date.now()) >= Date.parse(p.expiresAt) ||
      Date.parse(p.notBefore) >= Date.parse(p.expiresAt)
    )
      violation('signature, task or time');
    for (const name of p.allowedTools)
      if (!p.argConstraints[name] || !createAjv().validateSchema(p.argConstraints[name]))
        violation('invalid tool schema');
    for (const tool of p.allowedTools) assertToolSchema(p.argConstraints[tool]);
    if (i === 0) {
      if (p.issuer !== context.rootDid || p.parentHash !== null) violation('untrusted root');
    } else assertAttenuation(chain[i - 1], t);
  }
  const leaf = chain[chain.length - 1];
  if (leaf.payload.audience !== context.audience) violation('audience');
  return leaf;
}
export class CapabilityGuard {
  private counts = new Map<string, number>();
  private revoked = new Set<string>();
  constructor(private readonly registry?: RevocationList) {}
  revokeTask(taskId: string): void {
    this.revoked.add(taskId);
  }
  authorize(
    chain: CapabilityToken[],
    context: CapabilityContext,
    tool: string,
    args: Record<string, unknown>,
    resource: string,
  ): void {
    if (this.registry) {
      for (const token of chain) {
        if (
          this.registry.isRevoked('capability', token.payload.id) ||
          this.registry.isRevoked('capability', digest(token))
        )
          throw new Error('TOKEN_REVOKED');
      }
    }
    if (this.revoked.has(context.taskId)) violation('revoked task');
    const leaf = verifyCapabilityChain(chain, context);
    if (
      !leaf.payload.allowedTools.includes(tool) ||
      !resourceWithin(resource, leaf.payload.resource) ||
      !createAjv().compile(leaf.payload.argConstraints[tool])(args)
    )
      violation('tool, scope or arguments');
    // Reserve synchronously before any asynchronous tool side effect. Parent IDs
    // share counters across siblings; a caller must reuse this owner-side guard.
    for (const t of chain)
      if ((this.counts.get(digest(t)) ?? 0) >= t.payload.maxCalls) violation('maxCalls exhausted');
    for (const t of chain) {
      const id = digest(t);
      this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    }
  }
}
