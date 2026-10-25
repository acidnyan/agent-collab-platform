// SPDX-License-Identifier: Apache-2.0
// Run after pnpm build: node examples/network-collab/run.mjs
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = await mkdtemp(join(tmpdir(), 'acp-network-demo-'));
const processes = new Set();
function cli(args, onLine = () => {}) {
  const child = spawn(process.execPath, ['cli/dist/index.js', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); processes.add(child);
  let stdout = '', buffer = ''; child.stdout.on('data', b => { stdout += b; buffer += b; let i; while ((i = buffer.indexOf('\n')) >= 0) { onLine(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } }); child.stderr.pipe(process.stderr);
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => { processes.delete(child); code === 0 ? resolve(stdout) : reject(new Error('CLI failed: ' + args[0])); }); }); done.catch(() => {});
  return { child, done };
}
try {
  let relayReady; const relayUrl = new Promise(resolve => { relayReady = resolve; });
  const relay = cli(['relay', 'start', '--port', '0'], line => relayReady(JSON.parse(line).relay));
  const url = await Promise.race([relayUrl, relay.done.then(() => { throw new Error('Relay exited'); })]);
  const alice = join(dir, 'alice.private.json'), bob = join(dir, 'bob.private.json');
  await cli(['keygen', alice]).done; await cli(['keygen', bob]).done;
  let workerReady; const invite = new Promise(resolve => { workerReady = resolve; });
  const worker = cli(['worker', 'start', '--key', bob, '--relay', url, '--adapter', 'command', '--cmd', `${process.execPath} -e 'let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>console.log(JSON.stringify({summary:JSON.parse(s).text})));'`, '--auto-accept', '--once', '--audit', join(dir, 'bob.jsonl')], line => { if (line.startsWith('acp-invite:')) workerReady(line); });
  // WorkerNode and RequesterClient sign fresh relay receive tokens using their local --key files.
  const token = await Promise.race([invite, worker.done.then(() => { throw new Error('Worker exited'); })]);
  console.log(await cli(['delegate', '--key', alice, '--to', token, '--title', 'Report', '--description', 'Echo text as a summary', '--input', '{"text":"Two owners, separate processes"}', '--auto-approve', '--audit', join(dir, 'alice.jsonl'), '--out', join(dir, 'report.json')]).done);
  await worker.done;
  for (const owner of ['alice', 'bob']) console.log(owner + ': ' + await cli(['audit-verify', join(dir, owner + '.jsonl')]).done);
  console.log('Deliverable: ' + await readFile(join(dir, 'report.json'), 'utf8')); console.log('Audit files: ' + dir);
} finally { for (const child of processes) child.kill('SIGTERM'); }
