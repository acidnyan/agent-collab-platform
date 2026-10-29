import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
export interface DoctorOptions {
  version?: string;
  path?: string;
  home?: string;
  exists?: (path: string) => boolean;
  fetch?: typeof fetch;
}
export async function diagnose(options: DoctorOptions = {}) {
  const exists = options.exists ?? existsSync;
  const version = options.version ?? process.versions.node;
  const paths = (options.path ?? process.env.PATH ?? '').split(delimiter);
  const key = join(options.home ?? homedir(), '.acp', 'worker.private.json');
  const checks = [
    { name: 'Node.js', ok: Number(version.split('.')[0]) >= 22, message: `Node ${version}. Node 22 or newer is required; rerun the installer to update.` },
    { name: 'PATH', ok: paths.some(p => exists(join(p, process.platform === 'win32' ? 'sealbridge.cmd' : 'sealbridge'))), message: 'If sealbridge is not found, reopen your terminal or add the installer bin directory to PATH.' },
    { name: 'Keys', ok: true, message: exists(key) ? `Key file exists at ${key}; contents were not read.` : `No worker key at ${key}. Before receiving tasks, run: sealbridge keygen "${key}" (create the .acp directory first). Existing keys elsewhere can be used with --key.` },
  ];
  try {
    const response = await (options.fetch ?? fetch)('https://relay.sealbridge.dev/health', { signal: AbortSignal.timeout(8000), redirect: 'error' });
    checks.push({ name: 'Relay', ok: response.ok, message: response.ok ? 'https://relay.sealbridge.dev is reachable.' : `Relay returned HTTP ${response.status}. Check your connection and try again.` });
  } catch {
    checks.push({ name: 'Relay', ok: false, message: 'Cannot reach https://relay.sealbridge.dev. Check internet, proxy or firewall settings, then run sealbridge doctor again.' });
  }
  return checks;
}
export async function doctorCommand() {
  const checks = await diagnose();
  for (const check of checks) console.log(`${check.ok ? 'OK' : 'WARN'} ${check.name}: ${check.message}`);
  if (checks.some(check => !check.ok)) process.exitCode = 1;
}
