// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { startCredentialProxy } from './credential-proxy.js';
import { sanitizedEnvironment } from '@acp/sandbox';
import type { Json, AgentSkill } from '@acp/core';
import type { AgentAdapter, AgentTaskContext } from '@acp/runtime';
export interface CommandRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input: string;
  signal: AbortSignal;
  timeoutMs: number;
}
export interface CommandResult {
  stdout: string;
  stderr?: string;
  exitCode?: number;
}
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;
export async function resolveCommand(command: string): Promise<string> {
  if (isAbsolute(command)) return command;
  if (command.includes('/')) throw new Error('COMMAND_MUST_BE_ABSOLUTE_OR_ON_PATH');
  for (const dir of (process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const path = join(dir, command);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      /* next executable directory */
    }
  }
  throw new Error('COMMAND_NOT_FOUND: ' + command);
}
export const runCommand: CommandRunner = async (request) => {
  const command = await resolveCommand(request.command);
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, request.args, {
      cwd: request.cwd,
      env: request.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '',
      stderr = '',
      size = 0,
      settled = false;
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    };
    const finish = (error?: Error, code = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      kill();
      error ? reject(error) : resolve({ stdout, stderr, exitCode: code });
    };
    const abort = () => finish(new Error('ADAPTER_ABORTED'));
    const timer = setTimeout(() => finish(new Error('ADAPTER_TIMEOUT')), request.timeoutMs);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    child.stdout.on('data', (b: Buffer) => {
      size += b.length;
      if (size > 4194304) finish(new Error('ADAPTER_OUTPUT_LIMIT'));
      else stdout += b.toString();
    });
    child.stderr.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-4096);
    });
    child.on('error', () => finish(new Error('ADAPTER_SPAWN_FAILED')));
    child.on('close', (code) =>
      finish(code === 0 ? undefined : new Error('ADAPTER_EXIT: ' + code), code ?? 1),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(request.input);
  });
};
export function parseJsonDeliverable(value: unknown): Json {
  if (typeof value !== 'string') return JSON.parse(JSON.stringify(value)) as Json;
  const text = value
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```$/, '');
  try {
    return JSON.parse(text) as Json;
  } catch {
    throw new Error('ADAPTER_INVALID_JSON');
  }
}
export interface CommandAdapterOptions {
  command: string | string[];
  args?: string[];
  runner?: CommandRunner;
  id?: string;
  name?: string;
  skills?: AgentSkill[];
}
export class CommandAgentAdapter implements AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly skills: AgentSkill[];
  constructor(readonly options: CommandAdapterOptions) {
    this.id = options.id ?? 'command';
    this.name = options.name ?? 'Command Worker';
    this.skills = options.skills ?? [{ id: 'json-task', name: 'JSON task' }];
  }
  protected invocation(): { command: string; args: string[] } {
    if (Array.isArray(this.options.command)) {
      const [command, ...args] = this.options.command;
      if (!command) throw new Error('MISSING_COMMAND');
      return { command, args: [...args, ...(this.options.args ?? [])] };
    }
    // String commands are explicitly owner-configured shell scripts.
    return {
      command: '/bin/sh',
      args: ['-c', this.options.command, 'acp-task', ...(this.options.args ?? [])],
    };
  }
  protected decode(stdout: string, _context: AgentTaskContext): Json {
    return parseJsonDeliverable(stdout);
  }
  protected encodeInput(context: AgentTaskContext): string {
    return JSON.stringify(context.input);
  }
  async executeTask(context: AgentTaskContext): Promise<Json> {
    return this.executeCommand(context);
  }
  protected async executeCommand(
    context: AgentTaskContext,
    environment: NodeJS.ProcessEnv = {},
  ): Promise<Json> {
    context.signal.throwIfAborted();
    const started = Date.now();
    const input = JSON.stringify(context.input),
      inputFile = join(context.workspaceDir, 'input.json');
    await writeFile(inputFile, input, { mode: 0o600 });
    const invocation = this.invocation();
    try {
      const result = await (this.options.runner ?? runCommand)({
        ...invocation,
        cwd: context.workspaceDir,
        env: {
          ...sanitizedEnvironment(context.workspaceDir),
          PATH: '/usr/local/bin:/usr/bin:/bin',
          TASK_INPUT_FILE: inputFile,
          ...environment,
        },
        input: this.encodeInput(context),
        signal: context.signal,
        timeoutMs: context.manifest.budget.maxWallClockSeconds * 1000,
      });
      context.signal.throwIfAborted();
      if (result.exitCode && result.exitCode !== 0)
        throw new Error('ADAPTER_EXIT: ' + result.exitCode);
      return this.decode(result.stdout, context);
    } finally {
      context.reportUsage({ wallTimeMs: Date.now() - started });
      context.reportIsolation?.('workspace_process');
    }
  }
}
export interface CliOptions {
  binaryPath?: string;
  extraArgs?: string[];
  command?: string | string[];
  runner?: CommandRunner;
  apiKey?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}
function usage(context: AgentTaskContext, value: Record<string, unknown>) {
  const inputTokens = Number(value.input_tokens ?? value.prompt_tokens ?? 0),
    outputTokens = Number(value.output_tokens ?? value.completion_tokens ?? 0);
  context.reportUsage({
    inputTokens,
    outputTokens,
    totalTokens: Number(value.total_tokens ?? inputTokens + outputTokens),
  });
}
abstract class ProviderCliAdapter extends CommandAgentAdapter {
  protected cliOptions: CliOptions = {};
  protected abstract providerStyle: 'openai' | 'anthropic';
  protected override encodeInput(context: AgentTaskContext): string {
    return JSON.stringify({
      title: context.manifest.task.title,
      description: context.manifest.task.description,
      input: context.input,
      outputSchema: context.manifest.io.outputSchema,
      instruction: 'Return only a JSON deliverable.',
    });
  }
  override async executeTask(context: AgentTaskContext): Promise<Json> {
    const anthropic = this.providerStyle === 'anthropic';
    const key =
      this.cliOptions.apiKey ??
      process.env[
        this.cliOptions.apiKeyEnv ?? (anthropic ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY')
      ];
    if (!key || this.cliOptions.runner || this.cliOptions.command)
      return super.executeTask(context);
    const proxy = await startCredentialProxy({
      apiKey: key,
      baseUrl:
        this.cliOptions.baseUrl ??
        (anthropic ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'),
      style: this.providerStyle,
      signal: context.signal,
      fetch: this.cliOptions.fetch,
    });
    try {
      return await this.executeCommand(
        context,
        anthropic
          ? {
              ANTHROPIC_BASE_URL: proxy.url,
              ANTHROPIC_API_KEY: proxy.token,
              CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            }
          : { OPENAI_BASE_URL: proxy.url + '/v1', OPENAI_API_KEY: proxy.token },
      );
    } finally {
      await proxy.close();
    }
  }
}
export class ClaudeCodeAdapter extends ProviderCliAdapter {
  protected providerStyle = 'anthropic' as const;
  constructor(options: CliOptions = {}) {
    super({
      ...options,
      command: options.command ?? [
        options.binaryPath ?? 'claude',
        '-p',
        '--output-format',
        'json',
        ...(options.extraArgs ?? []),
      ],
      id: 'claude',
      name: 'Claude Code',
    });
    this.cliOptions = options;
  }
  protected override decode(stdout: string, context: AgentTaskContext): Json {
    const value = parseJsonDeliverable(stdout) as Record<string, Json>;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value.usage && typeof value.usage === 'object')
        usage(context, value.usage as Record<string, unknown>);
      if (value.is_error === true) throw new Error('CLAUDE_TASK_FAILED');
      if ('structured_output' in value) return parseJsonDeliverable(value.structured_output);
      if ('result' in value) return parseJsonDeliverable(value.result);
    }
    return value;
  }
}
export class CodexCliAdapter extends ProviderCliAdapter {
  protected providerStyle = 'openai' as const;
  constructor(options: CliOptions = {}) {
    super({
      ...options,
      command: options.command ?? [
        options.binaryPath ?? 'codex',
        'exec',
        '--json',
        '--skip-git-repo-check',
        ...(options.extraArgs ?? []),
        '-',
      ],
      id: 'codex',
      name: 'Codex CLI',
    });
    this.cliOptions = options;
  }
  protected override decode(stdout: string, context: AgentTaskContext): Json {
    let direct: Json;
    try {
      direct = JSON.parse(stdout) as Json;
    } catch {
      direct = null;
    }
    if (direct && typeof direct === 'object' && !Array.isArray(direct) && !('type' in direct)) {
      if (direct.usage && typeof direct.usage === 'object')
        usage(context, direct.usage as Record<string, unknown>);
      return 'result' in direct ? parseJsonDeliverable(direct.result) : direct;
    }
    let result: Json | undefined;
    for (const line of stdout.trim().split('\n')) {
      const event = JSON.parse(line) as {
        type?: string;
        usage?: Record<string, unknown>;
        item?: { type?: string; text?: string };
        result?: Json;
      };
      if (event.type === 'turn.failed' || event.type === 'error')
        throw new Error('CODEX_TASK_FAILED');
      if (event.usage) usage(context, event.usage);
      if (event.item?.type === 'agent_message' && event.item.text)
        result = parseJsonDeliverable(event.item.text);
      if (event.result !== undefined) result = parseJsonDeliverable(event.result);
    }
    if (result === undefined) throw new Error('CODEX_MISSING_RESULT');
    return result;
  }
}
