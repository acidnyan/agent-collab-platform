import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, readFile } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { join } from 'node:path';
import { diagnose, doctorCommand } from '../cli/src/doctor.js';

vi.mock('node:fs', () => ({ existsSync: vi.fn(), readFileSync: vi.fn(), readFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

const healthy = async () => new Response('{}', { status: 200 });
const initialExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = initialExitCode;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('doctor', () => {
  it.each(['22.22.0', '24.21.0'])('accepts Node %s without a fix hint', async version => {
    const checks = await diagnose({ version, execPath: '/node/bin/node', path: '/bin', exists: () => true, fetch: healthy as typeof fetch });
    expect(checks.map(c => c.name)).toEqual(['Node.js', 'PATH', 'Keys', 'Relay']);
    expect(checks.every(c => c.ok)).toBe(true);
    expect(checks.every(c => c.remediation === undefined)).toBe(true);
    expect(checks[0].message).toBe(`${version} (/node/bin/node)`);
  });

  it.each([true, false])('only checks key existence (present: %s)', async present => {
    const key = join('/test-home', '.acp', 'worker.private.json');
    vi.mocked(existsSync).mockImplementation(path => path === key && present);
    const checks = await diagnose({ home: '/test-home', path: '', fetch: healthy as typeof fetch });
    expect(existsSync).toHaveBeenCalledWith(key);
    expect(checks.find(c => c.name === 'Keys')).toEqual({
      name: 'Keys', ok: true, message: present ? 'Worker key present' : 'No worker key (optional)',
    });
    expect(readFileSync).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(readFileAsync).not.toHaveBeenCalled();
  });

  it('provides fixes for old Node, missing PATH and offline relay', async () => {
    const checks = await diagnose({ version: '20.0.0', path: '', exists: () => false, fetch: (async () => { throw new Error('offline'); }) as typeof fetch });
    expect(checks.filter(c => !c.ok).map(c => c.name)).toEqual(['Node.js', 'PATH', 'Relay']);
    expect(checks.filter(c => !c.ok).every(c => !!c.remediation)).toBe(true);
    expect(checks[0].remediation).toContain('Node 22 or newer is required; rerun the installer');
    expect(checks[1].remediation).toContain('Reopen your terminal');
    expect(checks.at(-1)?.remediation).toContain('run sealbridge doctor again');
  });

  it('reports HTTP failures and uses only the fixed health endpoint', async () => {
    const checks = await diagnose({ fetch: (async (url, init) => {
      expect(url).toBe('https://relay.sealbridge.dev/health');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeDefined();
      return new Response('', { status: 503 });
    }) as typeof fetch });
    expect(checks.at(-1)).toEqual({ name: 'Relay', ok: false, message: 'HTTP 503', remediation: 'Check your connection and try again.' });
  });

  it('prints short success lines including the running Node version and executable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await doctorCommand({ path: '/bin', exists: () => true, fetch: healthy as typeof fetch });
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      `Node.js: ${process.versions.node} (${process.execPath}) (OK)`,
      'PATH: sealbridge found (OK)',
      'Keys: Worker key present (OK)',
      'Relay: Reachable (OK)',
    ]);
    expect(process.exitCode).toBe(initialExitCode);
  });

  it('prints fix hints only on warning lines and sets a failure exit code', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await doctorCommand({ version: '20.0.0', execPath: '/old/node', path: '', exists: () => false,
      fetch: (async () => new Response('', { status: 503 })) as typeof fetch });
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'Node.js: 20.0.0 (/old/node) (WARN) Node 22 or newer is required; rerun the installer to update.',
      'PATH: sealbridge not found (WARN) Reopen your terminal or add the installer bin directory to PATH.',
      'Keys: No worker key (optional) (OK)',
      'Relay: HTTP 503 (WARN) Check your connection and try again.',
    ]);
    expect(process.exitCode).toBe(1);
  });
});
