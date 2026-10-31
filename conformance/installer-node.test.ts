import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const windows = process.platform === 'win32';
const installerPs = resolve('sites/install.ps1');
const installerSh = resolve('sites/install.sh');
const quoteSh = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

describe.skipIf(!windows)('Windows installer Node check', () => {
  let dir: string;
  let prefix: string;
  let first: string;
  let second: string;
  let driver: string;
  let preload: string;
  const shells = new Map<string, string>();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sealbridge-node-'));
    prefix = join(dir, 'npm prefix');
    first = join(dir, 'first Node');
    second = join(dir, 'second Node');
    for (const folder of [prefix, first, second]) {
      mkdirSync(folder);
      copyFileSync(process.execPath, join(folder, 'node.exe'));
    }
    for (const shell of ['powershell.exe', 'pwsh']) {
      const found = spawnSync('where.exe', [shell], { encoding: 'utf8' });
      expect(found.status, found.stderr).toBe(0);
      shells.set(shell, found.stdout.trim().split(/\r?\n/)[0]);
    }
    preload = join(dir, 'version.cjs');
    writeFileSync(preload, `
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(path.dirname(process.execPath), 'version.txt');
if (fs.existsSync(file)) {
  const version = fs.readFileSync(file, 'utf8');
  if (version === 'nonzero') process.exit(7);
  Object.defineProperty(process.versions, 'node', { value: version });
}
`);
    driver = join(dir, 'check.ps1');
    // Load the exact installer function without running installation or downloads.
    writeFileSync(driver, `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:SEALBRIDGE_TEST_INSTALLER, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$definition = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Get-SealbridgeNode' }, $true)
if (!$definition) { throw 'Installer Node check function is missing.' }
Invoke-Expression $definition.Extent.Text
$runtime = Get-SealbridgeNode -Prefix $env:SEALBRIDGE_TEST_PREFIX
@{ ShellMajor = $PSVersionTable.PSVersion.Major; Runtime = $runtime } | ConvertTo-Json -Compress
`);
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function check(shell: string, paths: string[], useFakeVersion = true, usePrefix = false) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    // Exclude any other Node installations while retaining Windows utilities.
    env.Path = [...paths, join(process.env.SystemRoot!, 'System32'), process.env.SystemRoot!].join(';');
    env.SEALBRIDGE_TEST_INSTALLER = installerPs;
    env.SEALBRIDGE_TEST_PREFIX = usePrefix ? prefix : join(dir, 'empty prefix');
    delete env.NODE_OPTIONS;
    if (useFakeVersion) env.NODE_OPTIONS = `--require "${preload.replaceAll('\\', '/')}"`;
    const result = spawnSync(shells.get(shell)!, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver], {
      env, encoding: 'utf8', timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout.trim());
    expect(output.ShellMajor).toBe(shell === 'powershell.exe' ? 5 : 7);
    return output.Runtime as { Path: string; Version: string; Supported: boolean } | null;
  }

  describe.each(['powershell.exe', 'pwsh'])('%s', shell => {
    it('checks a real Node on PATH and reports its resolved executable and version', () => {
      expect(check(shell, [dirname(process.execPath)], false)).toEqual({
        Path: process.execPath, Version: process.versions.node, Supported: true,
      });
    });

    it.each([
      ['20.0.0', false], ['21.7.3', false], ['22.0.0', true], ['22.22.0', true], ['24.21.0', true],
    ])('parses %s without nested JavaScript quotes (supported: %s)', (version, supported) => {
      writeFileSync(join(first, 'version.txt'), version);
      expect(check(shell, [first])).toEqual({ Path: join(first, 'node.exe'), Version: version, Supported: supported });
    });

    it.each(['invalid', 'nonzero'])('rejects an unusable Node (%s)', version => {
      writeFileSync(join(first, 'version.txt'), version);
      expect(check(shell, [first])).toBeNull();
    });

    it('reports no runtime when Node is absent', () => {
      expect(check(shell, [])).toBeNull();
    });

    it('follows PATH order when the prefix has no Node', () => {
      writeFileSync(join(first, 'version.txt'), '24.21.0');
      writeFileSync(join(second, 'version.txt'), '22.22.0');
      expect(check(shell, [second, first])).toEqual({ Path: join(second, 'node.exe'), Version: '22.22.0', Supported: true });
    });

    it.each([['22.22.0', true], ['20.0.0', false]])('prefers prefix-local Node %s over PATH', (version, supported) => {
      writeFileSync(join(first, 'version.txt'), '24.21.0');
      writeFileSync(join(prefix, 'version.txt'), version);
      expect(check(shell, [first], true, true)).toEqual({ Path: join(prefix, 'node.exe'), Version: version, Supported: supported });
    });
  });
});

describe.skipIf(windows)('POSIX installer Node check', () => {
  let dir: string;
  let bin: string;
  let checkNode: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sealbridge-node-'));
    bin = join(dir, 'Node bin');
    mkdirSync(bin);
    const source = readFileSync(installerSh, 'utf8');
    checkNode = source.match(/^check_node\(\) \{\n[\s\S]*?^\}/m)?.[0] ?? '';
    expect(checkNode).not.toBe('');
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function fakeNode(version: string) {
    writeFileSync(join(bin, 'node'), `#!/bin/sh
case "$1:$2" in
  -p:process.versions.node) printf '%s\\n' ${quoteSh(version)};;
  -p:process.execPath) printf '%s\\n' ${quoteSh(join(bin, 'node'))};;
  *) exit 9;;
esac
`, { mode: 0o755 });
  }

  it.each([['20.0.0', 1], ['22.22.0', 0], ['24.21.0', 0], ['invalid', 1]])('checks %s using stdout and shell parsing', (version, status) => {
    fakeNode(version);
    const result = spawnSync('sh', ['-c', `${checkNode}\ncheck_node`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(status);
    expect(result.stderr).toBe('');
  });

  it('reports the resolved executable and version of a real Node on PATH', () => {
    const result = spawnSync('sh', ['-c', `${checkNode}\ncheck_node || exit 1\nprintf '%s\\n%s\\n' "$NODE_EXECUTABLE" "$NODE_ACTUAL_VERSION"`], {
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([process.execPath, process.versions.node]);
  });

  it('reuses a suitable Node and prints its path and version during installation', () => {
    fakeNode('24.21.0');
    writeFileSync(join(bin, 'npm'), `#!/bin/sh
mkdir -p "$4/bin"
printf '#!/bin/sh\\nexit 0\\n' > "$4/bin/sealbridge"
chmod +x "$4/bin/sealbridge"
`, { mode: 0o755 });
    // Any attempted download fails locally; this scenario must reuse Node.
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 90\n', { mode: 0o755 });
    const result = spawnSync('sh', [installerSh], {
      env: { ...process.env, HOME: join(dir, 'test home'), PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Node.js: 24.21.0 (${join(bin, 'node')})`);
  });
});
