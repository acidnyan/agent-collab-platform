import { describe, it, expect } from 'vitest';
import { diagnose } from '../cli/src/doctor.js';
const healthy = async () => new Response('{}', { status: 200 });
describe('doctor', () => {
  it('accepts Node 22+ and missing optional keys without reading secrets', async () => {
    const checks = await diagnose({ version: '22.22.0', path: '', exists: () => true, fetch: healthy as typeof fetch });
    expect(checks.every(c => c.ok)).toBe(true);
    expect(checks.find(c => c.name === 'Keys')?.message).toContain('contents were not read');
  });
  it('provides fixes for old Node, missing PATH and offline relay', async () => {
    const checks = await diagnose({ version: '20.0.0', path: '', exists: () => false, fetch: (async () => { throw new Error('offline'); }) as typeof fetch });
    expect(checks.filter(c => !c.ok).map(c => c.name)).toEqual(['Node.js', 'PATH', 'Relay']);
    expect(checks.find(c => c.name === 'Keys')?.message).toContain('keygen');
  });
  it('reports HTTP failures and uses only the fixed health endpoint', async () => {
    const checks = await diagnose({ fetch: (async (url, init) => {
      expect(url).toBe('https://relay.sealbridge.dev/health');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeDefined();
      return new Response('', { status: 503 });
    }) as typeof fetch });
    expect(checks.at(-1)?.ok).toBe(false);
    expect(checks.at(-1)?.message).toContain('503');
  });
});
