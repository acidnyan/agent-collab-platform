// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createContract,
  generateKeyPair,
  signApproval,
  signEnvelope,
  signPayload,
  signUsage,
  validateManifest,
} from '../packages/core/src/index.js';
import type { Json, KeyPair } from '../packages/core/src/index.js';
import {
  ApprovalGate,
  VerificationEngine,
  buildTaskManifest,
  createDelivery,
} from '../packages/runtime/src/index.js';
import type { AgentTaskContext } from '../packages/runtime/src/index.js';
import { SandboxAgentAdapter } from '../packages/adapters/src/index.js';
import {
  OCI_CONTAINER_BOUNDARY,
  buildRestrictedSubprocessArgv,
  containerArguments,
  detectNodePermissionFlag,
  prefersStableNodePermissionFlag,
  resolveNodePermissionArgs,
  runContainerOrSubprocessSandbox,
  runSandbox,
  sanitizedEnvironment,
  subprocessSandboxBoundary,
} from '../packages/sandbox/src/index.js';
import type { NodePermissionProbe, SandboxBoundaryMetadata } from '../packages/sandbox/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const codeTokens = [
  'node:vm',
  '--permission',
  '--experimental-permission',
  'fetch',
  'node:net',
  'node:http',
  'node:https',
  'node:dns',
  'node:dgram',
  '--allow-fs-read',
  '--allow-fs-write',
  'subprocess_restricted',
  "isolationLevel: 'oci_container'",
  '--network none',
  '--read-only',
  '--cap-drop ALL',
  'no-new-privileges',
  'effectiveIsolationLevel',
];

function readDoc(name: string): string {
  return readFileSync(join(root, name), 'utf8');
}

function probe(nodeVersion: string, flags: string[]): NodePermissionProbe {
  return { nodeVersion, flags };
}

function runNode(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('P2-13 Node permission flag selection', () => {
  it.each([
    ['20.18.1', ['--experimental-permission', '--allow-fs-read'], '--experimental-permission'],
    ['22.12.0', ['--experimental-permission', '--permission'], '--experimental-permission'],
    ['22.13.0', ['--permission', '--experimental-permission'], '--permission'],
    ['22.13.0', ['--experimental-permission'], '--experimental-permission'],
    ['22.23.4', ['--permission'], '--permission'],
    ['23.0.0', ['--permission', '--experimental-permission'], '--permission'],
    ['23.5.0', ['--experimental-permission'], '--experimental-permission'],
    ['24.1.0', ['--permission'], '--permission'],
    ['v22.13.1', ['--permission', '--experimental-permission'], '--permission'],
  ] as const)('node %s with %j uses %s', (nodeVersion, flags, expected) => {
    const resolved = resolveNodePermissionArgs('/tmp/acp-scratch', probe(nodeVersion, [...flags]));
    expect(detectNodePermissionFlag(probe(nodeVersion, [...flags]))).toBe(expected);
    expect(resolved.flag).toBe(expected);
    expect(resolved.args).toEqual([
      expected,
      '--allow-fs-read=/tmp/acp-scratch',
      '--allow-fs-write=/tmp/acp-scratch',
    ]);
    expect(resolved.boundary).toEqual({
      nodePermissionFlag: expected,
      permissionModelActive: true,
      kernelNetworkIsolated: false,
    });
    expect(resolved.args[0] === '--permission' || resolved.args[0] === '--experimental-permission').toBe(
      true,
    );
    expect(resolved.args.findIndex((arg) => arg.startsWith('--allow-fs-'))).toBeGreaterThan(0);
  });

  it('omits --allow-fs-* when neither permission flag is advertised', () => {
    for (const nodeVersion of ['18.20.0', '20.10.0', '22.13.0', '23.0.0']) {
      const resolved = resolveNodePermissionArgs('/tmp/acp-scratch', probe(nodeVersion, ['--no-addons']));
      expect(resolved.flag).toBeNull();
      expect(resolved.args).toEqual([]);
      expect(resolved.boundary).toEqual({
        nodePermissionFlag: null,
        permissionModelActive: false,
        kernelNetworkIsolated: false,
      });
    }
    expect(prefersStableNodePermissionFlag('22.12.9')).toBe(false);
    expect(prefersStableNodePermissionFlag('22.13.0')).toBe(true);
    expect(prefersStableNodePermissionFlag('23.0.0')).toBe(true);
    expect(prefersStableNodePermissionFlag('20.18.1')).toBe(false);
  });

  it('refuses a permission allowlist that would cover the whole filesystem', () => {
    const stable = probe('22.23.4', ['--permission']);
    expect(() => resolveNodePermissionArgs('/', stable)).toThrow('INVALID_SANDBOX_DIRECTORY');
    expect(() => resolveNodePermissionArgs('/tmp/a,b', stable)).toThrow('INVALID_SANDBOX_DIRECTORY');
    expect(() => resolveNodePermissionArgs('', stable)).toThrow('INVALID_SANDBOX_DIRECTORY');
  });

  it('pairs --allow-fs-read and --allow-fs-write with the flag on this Node binary', () => {
    const flag = detectNodePermissionFlag();
    const version = process.versions.node;
    const advertised = process.allowedNodeEnvironmentFlags;
    if (prefersStableNodePermissionFlag(version) && advertised.has('--permission'))
      expect(flag).toBe('--permission');
    else if (advertised.has('--experimental-permission'))
      expect(flag).toBe('--experimental-permission');
    else expect(flag).toBeNull();
    const directory = '/tmp/acp-live-scratch';
    const resolved = resolveNodePermissionArgs(directory);
    expect(resolved.flag).toBe(flag);
    expect(subprocessSandboxBoundary()).toEqual(resolved.boundary);
    expect(resolved.boundary.kernelNetworkIsolated).toBe(false);
    if (!flag) {
      expect(resolved.args).toEqual([]);
      expect(resolved.boundary.permissionModelActive).toBe(false);
      return;
    }
    expect(process.allowedNodeEnvironmentFlags.has(flag)).toBe(true);
    expect(resolved.args.slice(0, 3)).toEqual([
      flag,
      '--allow-fs-read=' + directory,
      '--allow-fs-write=' + directory,
    ]);
    expect(resolved.boundary.permissionModelActive).toBe(true);
    const argv = buildRestrictedSubprocessArgv(directory, join(directory, 'runner.cjs'));
    expect(argv[0]).toBe(flag);
    expect(argv).toContain('--allow-fs-read=' + directory);
    expect(argv).toContain('--allow-fs-write=' + directory);
    expect(argv).toContain('--no-addons');
  });
});

describe('P2-13 subprocess_restricted boundary', () => {
  it('denies files outside the scratch directory, strips env, and leaves network APIs in place', async () => {
    expect(detectNodePermissionFlag()).not.toBeNull();
    // Same symlink canonicalization as runSandbox. On macOS, leaving the
    // /var/folders path makes --allow-fs-read stat '/var' and throw ERR_ACCESS_DENIED.
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'acp-p213-')));
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'acp-p213-out-')));
    const previous = process.env.OPENAI_API_KEY;
    const previousOptions = process.env.NODE_OPTIONS;
    process.env.OPENAI_API_KEY = 'sk-p213-should-not-leak';
    process.env.NODE_OPTIONS = '--inspect';
    try {
      const script = join(directory, 'probe.cjs');
      const inside = join(directory, 'inside.txt');
      const hidden = join(outside, 'secret.txt');
      await writeFile(inside, 'hello');
      await writeFile(hidden, 'nope');
      await writeFile(
        script,
        [
          "const fs = require('node:fs');",
          'const outside = process.argv[2];',
          'const inside = process.argv[3];',
          "let outsideCode = 'READ_OK';",
          'try { fs.readFileSync(outside, "utf8"); } catch (e) { outsideCode = e.code; }',
          'let childCode = "SPAWN_OK";',
          "try { require('node:child_process').spawnSync(process.execPath, ['-e', '0']); }",
          'catch (e) { childCode = e.code; }',
          'console.log(JSON.stringify({',
          '  outsideCode,',
          '  insideText: fs.readFileSync(inside, "utf8"),',
          '  env: process.env,',
          '  fetch: typeof fetch,',
          '  WebSocket: typeof WebSocket,',
          "  net: typeof require('node:net').connect,",
          "  http: typeof require('node:http').request,",
          "  https: typeof require('node:https').request,",
          "  dns: typeof require('node:dns').lookup,",
          "  dgram: typeof require('node:dgram').createSocket,",
          '  childCode,',
          '}));',
        ].join('\n'),
      );
      const env = sanitizedEnvironment(directory);
      expect(env).toEqual({
        LANG: 'C.UTF-8',
        TZ: 'UTC',
        HOME: directory,
        TMPDIR: directory,
      });
      expect(env).not.toHaveProperty('OPENAI_API_KEY');
      expect(env).not.toHaveProperty('NODE_OPTIONS');
      expect(env).not.toHaveProperty('PATH');
      const ran = await runNode(
        [...buildRestrictedSubprocessArgv(directory, script), hidden, inside],
        { cwd: directory, env },
      );
      expect(ran.stderr).not.toContain('sk-p213-should-not-leak');
      expect(ran.code).toBe(0);
      const body = JSON.parse(ran.stdout) as {
        outsideCode: string;
        insideText: string;
        env: Record<string, string>;
        fetch: string;
        WebSocket: string;
        net: string;
        http: string;
        https: string;
        dns: string;
        dgram: string;
        childCode: string;
      };
      expect(body.outsideCode).toBe('ERR_ACCESS_DENIED');
      expect(body.insideText).toBe('hello');
      expect(body.childCode).toBe('ERR_ACCESS_DENIED');
      expect(body.env.HOME).toBe(directory);
      expect(body.env.LANG).toBe('C.UTF-8');
      expect(body.env.TMPDIR).toBe(directory);
      expect(body.env.TZ).toBe('UTC');
      // Windows/libuv and macOS CoreFoundation still inject system variables
      // after an explicit env block. Those keys are not credentials. Anything
      // else, including provider keys and NODE_OPTIONS, must stay absent.
      const allowed = new Set(['HOME', 'LANG', 'TMPDIR', 'TZ']);
      const windowsOsKeys = new Set(
        [
          'ALLUSERSPROFILE',
          'APPDATA',
          'COMMONPROGRAMFILES',
          'COMMONPROGRAMFILES(X86)',
          'COMSPEC',
          'DRIVERDATA',
          'HOMEDRIVE',
          'HOMEPATH',
          'LOCALAPPDATA',
          'LOGONSERVER',
          'NUMBER_OF_PROCESSORS',
          'OS',
          'PATH',
          'PATHEXT',
          'PROCESSOR_ARCHITECTURE',
          'PROCESSOR_IDENTIFIER',
          'PROCESSOR_LEVEL',
          'PROCESSOR_REVISION',
          'PROGRAMDATA',
          'PROGRAMFILES',
          'PROGRAMFILES(X86)',
          'PSMODULEPATH',
          'PUBLIC',
          'SYSTEM',
          'SYSTEMDRIVE',
          'SYSTEMROOT',
          'TEMP',
          'TMP',
          'USERDOMAIN',
          'USERDOMAIN_ROAMINGPROFILE',
          'USERNAME',
          'USERPROFILE',
          'WINDIR',
        ].map((key) => key.toUpperCase()),
      );
      const darwinOsKeys = new Set(['__CF_USER_TEXT_ENCODING']);
      const unexpected = Object.keys(body.env).filter((key) => {
        if (allowed.has(key)) return false;
        if (process.platform === 'win32') return !windowsOsKeys.has(key.toUpperCase());
        if (process.platform === 'darwin') return !darwinOsKeys.has(key);
        return true;
      });
      expect(unexpected).toEqual([]);
      expect(body.env.OPENAI_API_KEY).toBeUndefined();
      expect(body.env.NODE_OPTIONS).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain('sk-p213-should-not-leak');
      expect(JSON.stringify(body.env)).not.toContain('--inspect');
      // The permission model does not remove these. Kernel network isolation is OCI.
      expect(body).toMatchObject({
        fetch: 'function',
        WebSocket: 'function',
        net: 'function',
        http: 'function',
        https: 'function',
        dns: 'function',
        dgram: 'function',
      });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousOptions;
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('hides Node globals from guest code and kills a non-cooperative loop', async () => {
    const guest = await runSandbox({
      code: 'return [typeof process, typeof require, typeof fetch, typeof WebSocket];',
      timeoutMs: 2000,
      onTool: async () => null,
    });
    expect(guest).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
    await expect(
      runSandbox({ code: 'while(true){}', timeoutMs: 200, onTool: async () => null }),
    ).rejects.toThrow(/SANDBOX_TIMEOUT|TIMEOUT|timed out|EXIT/);
  });

  it('reports subprocess_restricted, which VerificationEngine rejects for an oci_container contract', async () => {
    const result = await runContainerOrSubprocessSandbox({
      isolationLevel: 'oci_container',
      runtime: null,
      code: 'return { ok: true };',
      timeoutMs: 2000,
      onTool: async () => null,
    });
    expect(result.effectiveIsolationLevel).toBe('subprocess_restricted');
    expect(result.output).toEqual({ ok: true });
    expect(result.sandboxBoundary).toEqual(subprocessSandboxBoundary());
    expect(result.sandboxBoundary.kernelNetworkIsolated).toBe(false);
    expect(result.sandboxBoundary.permissionModelActive).toBe(detectNodePermissionFlag() !== null);

    const owner = generateKeyPair();
    const worker = generateKeyPair();
    const rejected = await verifyLevel(owner, worker, result.effectiveIsolationLevel, result.sandboxBoundary);
    expect(rejected.accepted).toBe(false);
    expect(rejected.reason).toContain('ISOLATION_LEVEL_MISMATCH');
    const lied = await verifyLevel(owner, worker, 'subprocess_restricted', {
      ...result.sandboxBoundary,
      kernelNetworkIsolated: true,
    });
    expect(lied.accepted).toBe(false);
    expect(lied.reason).toContain('ISOLATION_LEVEL_MISMATCH');
    const accepted = await verifyLevel(owner, worker, 'oci_container', OCI_CONTAINER_BOUNDARY);
    expect(accepted.accepted).toBe(true);

    const manifest = buildTaskManifest({
      ownerDid: owner.did,
      workerDid: worker.did,
      title: 'Sandbox report',
      description: 'Report the host isolation level',
    });
    manifest.sandboxPolicy.isolationLevel = 'subprocess_restricted';
    validateManifest(manifest);
    let reported = '';
    let boundary: SandboxBoundaryMetadata | undefined;
    const workspaceDir = await mkdtemp(join(tmpdir(), 'acp-p213-adapter-'));
    try {
      const output = await new SandboxAgentAdapter('return input;').executeTask(
        await taskContext(manifest, workspaceDir, (level, reportedBoundary) => {
          reported = level;
          boundary = reportedBoundary;
        }),
      );
      expect(output).toEqual({ n: 1 });
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
    expect(reported).toBe('subprocess_restricted');
    expect(boundary).toEqual(subprocessSandboxBoundary());

    const flags = containerArguments('/tmp/acp-p213-oci');
    expect(flags[flags.indexOf('--network') + 1]).toBe('none');
    expect(flags).toContain('--read-only');
    expect(flags[flags.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(flags[flags.indexOf('--security-opt') + 1]).toBe('no-new-privileges');
    expect(OCI_CONTAINER_BOUNDARY).toEqual({
      nodePermissionFlag: null,
      permissionModelActive: false,
      kernelNetworkIsolated: true,
    });
  });
});

describe('P2-13 documentation states the vm and permission-model limits', () => {
  it.each([
    'SECURITY_PROOF.md',
    'ARCHITECTURE.md',
    'README.md',
    'docs/security-model.md',
    'AGENTS.md',
    'SKILL.md',
    'spec/README.md',
  ])('%s states that node:vm is not a security mechanism and OCI is required', (name) => {
    const text = readDoc(name);
    for (const token of codeTokens) expect(text, token).toContain(token);
    expect(text).toContain('not a security mechanism');
    expect(text).toContain('kernel network');
  });

  it.each([
    'SECURITY_PROOF.ja.md',
    'ARCHITECTURE.ja.md',
    'README.ja.md',
    'spec/README.ja.md',
  ])('%s states the same boundary in Japanese', (name) => {
    const text = readDoc(name);
    for (const token of codeTokens) expect(text, token).toContain(token);
    expect(text).toContain('セキュリティ機構ではない');
    expect(text).toContain('カーネル');
  });
});

async function taskContext(
  manifest: ReturnType<typeof buildTaskManifest>,
  workspaceDir: string,
  reportIsolation: (level: string, boundary?: SandboxBoundaryMetadata) => void,
): Promise<AgentTaskContext> {
  return {
    taskId: manifest.taskId,
    manifest,
    input: { n: 1 },
    workspaceDir,
    signal: AbortSignal.timeout(15000),
    callTool: async () => {
      throw new Error('TOOL_DENIED');
    },
    reportUsage: () => {},
    reportIsolation,
  };
}

async function verifyLevel(
  owner: KeyPair,
  worker: KeyPair,
  level: string,
  boundary: SandboxBoundaryMetadata,
) {
  const manifest = buildTaskManifest({
    ownerDid: owner.did,
    workerDid: worker.did,
    title: 'Require OCI',
    description: 'Reject a subprocess attestation',
    outputSchema: { type: 'object', additionalProperties: false },
  });
  manifest.sandboxPolicy.isolationLevel = 'oci_container';
  validateManifest(manifest);
  const contract = createContract(manifest, signPayload(manifest, owner), worker);
  const usage = signUsage(
    {
      type: 'UsageReceipt',
      taskId: manifest.taskId,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      toolCalls: 0,
      wallTimeMs: 0,
      halted: false,
    },
    worker,
  );
  const delivery = createDelivery(manifest.taskId, contract.contractDigest, {}, usage, worker, {
    effectiveIsolationLevel: level,
    sandboxBoundary: boundary,
  });
  expect(delivery.attestation.payload.effectiveIsolationLevel).toBe(level);
  expect(delivery.attestation.payload.sandboxBoundary).toEqual(boundary);
  const envelope = signEnvelope(
    {
      taskId: manifest.taskId,
      recipientDid: owner.did,
      seq: 0,
      eventType: 'DELIVER',
      payload: delivery as unknown as Json,
    },
    worker,
  );
  const gate = new ApprovalGate(owner.did, { requiredGates: [], autoApprove: [] });
  const approval = signApproval(manifest.taskId, 'final_verification', delivery, owner);
  return new VerificationEngine({ allowUnencryptedEnvelopes: true }).verify(
    contract,
    envelope,
    gate,
    approval,
  );
}
