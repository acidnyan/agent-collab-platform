import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';
export interface DoctorOptions {
  version?: string;
  execPath?: string;
  path?: string;
  home?: string;
  exists?: (path: string) => boolean;
  fetch?: typeof fetch;
}
export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  remediation?: string;
}
export async function diagnose(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const exists = options.exists ?? existsSync;
  const version = options.version ?? process.versions.node;
  const paths = (options.path ?? process.env.PATH ?? '').split(delimiter);
  const key = join(options.home ?? homedir(), '.acp', 'worker.private.json');
  const nodeOk = Number(version.split('.')[0]) >= 22;
  const pathOk = paths.some(p => exists(join(p, process.platform === 'win32' ? 'sealbridge.cmd' : 'sealbridge')));
  const checks: DoctorCheck[] = [
    { name: 'Node.js', ok: nodeOk, message: `${version} (${options.execPath ?? process.execPath})`,
      ...(!nodeOk && { remediation: 'Node 22 or newer is required; rerun the installer to update.' }) },
    { name: 'PATH', ok: pathOk, message: pathOk ? 'sealbridge found' : 'sealbridge not found',
      ...(!pathOk && { remediation: 'Reopen your terminal or add the installer bin directory to PATH.' }) },
    { name: 'Keys', ok: true, message: exists(key) ? 'Worker key present' : 'No worker key (optional)' },
  ];
  try {
    const response = await (options.fetch ?? fetch)('https://relay.sealbridge.dev/health', { signal: AbortSignal.timeout(8000), redirect: 'error' });
    checks.push({ name: 'Relay', ok: response.ok, message: response.ok ? 'Reachable' : `HTTP ${response.status}`,
      ...(!response.ok && { remediation: 'Check your connection and try again.' }) });
  } catch {
    checks.push({ name: 'Relay', ok: false, message: 'Unreachable', remediation: 'Check internet, proxy or firewall settings, then run sealbridge doctor again.' });
  }
  return checks;
}
export async function doctorCommand(options: DoctorOptions = {}) {
  const checks = await diagnose(options);
  for (const check of checks) console.log(`${check.name}: ${check.message} (${check.ok ? 'OK' : 'WARN'})${!check.ok && check.remediation ? ` ${check.remediation}` : ''}`);
  if (checks.some(check => !check.ok)) process.exitCode = 1;
}
