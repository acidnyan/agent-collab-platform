// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Json } from '@acp/core';
export interface SandboxOptions {
  code: string;
  input?: Json;
  timeoutMs: number;
  onTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  onUsage?: (inputTokens: number, outputTokens: number) => void;
  signal?: AbortSignal;
}
// This trusted wrapper is the only code with access to Node APIs. VM values cross
// the process boundary as JSON, never as host functions, objects or credentials.
export const sandboxWrapper = String.raw`
const vm = require('node:vm');
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync('task.json', 'utf8'));
const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
const bootstrap = 'globalThis.queue=[]; globalThis.waiters=new Map(); globalThis.serial=0; globalThis.finished=false; globalThis.callTool=(name,args)=>new Promise((resolve,reject)=>{const id=++serial;waiters.set(id,{resolve,reject});queue.push({id,name,args});}); globalThis.reportUsage=(inputTokens,outputTokens)=>callTool("$usage",{inputTokens,outputTokens}); globalThis.input=JSON.parse(' + JSON.stringify(JSON.stringify(config.input)) + ');';
vm.runInContext(bootstrap, context, { timeout: 100 });
new vm.Script('(async()=>{'+config.code+'})().then(value=>{globalThis.result=JSON.stringify({value:value===undefined?null:value});globalThis.finished=true;},error=>{globalThis.result=JSON.stringify({error:String(error)});globalThis.finished=true;});').runInContext(context, { timeout: config.timeoutMs });
const timer = setInterval(()=>{
 try {
   const queued=JSON.parse(vm.runInContext('JSON.stringify(queue.splice(0))',context,{timeout:100}));
   for(const req of queued)process.send({type:'tool',...req});
   if(vm.runInContext('finished',context,{timeout:100})){clearInterval(timer);process.send({type:'done',...JSON.parse(vm.runInContext('result',context,{timeout:100}))});process.disconnect();}
 } catch(e){process.send({type:'done',error:String(e)});process.exit(1);}
},5);
process.on('message',msg=>{
 try { const data=JSON.stringify(msg); vm.runInContext('{const r=JSON.parse('+JSON.stringify(data)+');const w=waiters.get(r.id);if(w){waiters.delete(r.id);r.error?w.reject(new Error(r.error)):w.resolve(r.value);}}',context,{timeout:100}); }
 catch(e){process.send({type:'done',error:String(e)});process.exit(1);}
});
`;
export function sanitizedEnvironment(directory: string): NodeJS.ProcessEnv {
  // Build an allowlist from scratch: NODE_OPTIONS, proxy auth, cloud credentials,
  // provider keys, SSH sockets and inherited PATH never enter the worker.
  return { LANG: 'C.UTF-8', TZ: 'UTC', HOME: directory, TMPDIR: directory };
}
export async function runSandbox(options: SandboxOptions): Promise<Json> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 604800000
  )
    throw new Error('INVALID_TIMEOUT');
  const directory = await mkdtemp(join(tmpdir(), 'acp-task-'));
  let child: ChildProcess | undefined;
  let exited = Promise.resolve();
  try {
    await writeFile(join(directory, 'runner.cjs'), sandboxWrapper, { mode: 0o600 });
    await writeFile(
      join(directory, 'task.json'),
      JSON.stringify({
        code: options.code,
        input: options.input ?? null,
        timeoutMs: options.timeoutMs,
      }),
      { mode: 0o600 },
    );
    return await new Promise<Json>((resolve, reject) => {
      const subprocess = spawn(
        process.execPath,
        [
          '--experimental-permission',
          '--allow-fs-read=' + directory,
          '--allow-fs-write=' + directory,
          '--no-addons',
          '--disable-proto=throw',
          '--max-old-space-size=64',
          join(directory, 'runner.cjs'),
        ],
        {
          cwd: directory,
          env: sanitizedEnvironment(directory),
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        },
      );
      child = subprocess;
      // `close` means stdio and the process handle are gone, so Windows can release cwd.
      exited = new Promise((resolveExit) => {
        const finished = () => resolveExit();
        subprocess.once('exit', finished);
        subprocess.once('close', finished);
      });
      let done = false,
        requests = 0,
        stderr = '';
      const finish = (error?: Error, result?: Json) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (subprocess.exitCode === null && !subprocess.killed) subprocess.kill('SIGKILL');
        error ? reject(error) : resolve(result ?? null);
      };
      const abort = () => finish(new Error('SANDBOX_HALTED: ' + String(options.signal?.reason)));
      const timer = setTimeout(() => finish(new Error('SANDBOX_TIMEOUT')), options.timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      subprocess.stderr?.on('data', (b: Buffer) => {
        stderr = (stderr + b.toString()).slice(-4096);
      });
      // Requests arrive from another OS process. The child has no tool handlers,
      // capability counters, private keys or credentials, and cannot skip CapGuard.
      let serial = Promise.resolve();
      subprocess.on('message', (message: unknown) => {
        serial = serial
          .then(async () => {
            if (done) return;
            const m = message as {
              type: string;
              id: number;
              name: string;
              args: Record<string, unknown>;
              error?: string;
              value?: Json;
            };
            if (JSON.stringify(m).length > 1048576)
              return finish(new Error('SANDBOX_MESSAGE_LIMIT'));
            if (m.type === 'done') return finish(m.error ? new Error(m.error) : undefined, m.value);
            if (m.type !== 'tool' || ++requests > 10000)
              return finish(new Error('SANDBOX_PROTOCOL'));
            try {
              let value: unknown = null;
              if (m.name === '$usage') {
                if (!options.onUsage) throw new Error('USAGE_ADAPTER_REQUIRED');
                options.onUsage(m.args.inputTokens as number, m.args.outputTokens as number);
              } else value = await options.onTool(m.name, m.args);
              if (!done && subprocess.connected) subprocess.send({ id: m.id, value });
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)));
            }
          })
          .catch((e) => finish(e as Error));
      });
      subprocess.on('error', (e) => finish(e));
      subprocess.on('exit', (code) => {
        if (!done) finish(new Error('SANDBOX_EXIT: ' + code + ' ' + stderr));
      });
    });
  } finally {
    try {
      if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
      // Wait until the child has actually exited, then give Windows a short retry window.
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 250))]);
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // EBUSY, EPERM, and EACCES while deleting the temp dir must not replace the result.
    }
  }
}

export * from './container.js';
