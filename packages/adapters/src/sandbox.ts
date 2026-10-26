// SPDX-License-Identifier: Apache-2.0
import { runContainerOrSubprocessSandbox } from '@acp/sandbox';
import type { AgentAdapter, AgentTaskContext } from '@acp/runtime';
import type { Json } from '@acp/core';
export class SandboxAgentAdapter implements AgentAdapter {
  readonly id = 'sandbox';
  readonly name = 'Restricted JavaScript Worker';
  readonly skills = [{ id: 'json-task', name: 'JSON task' }];
  constructor(readonly code = 'return input;') {}
  async executeTask(context: AgentTaskContext): Promise<Json> {
    const policy = context.manifest.sandboxPolicy;
    if (policy.networkAccess !== 'none' || policy.filesystemScope !== 'ephemeral_workspace_only')
      throw new Error('UNSUPPORTED_SANDBOX_POLICY');
    const result = await runContainerOrSubprocessSandbox({
      code: this.code,
      input: context.input,
      isolationLevel: policy.isolationLevel,
      timeoutMs: context.manifest.budget.maxWallClockSeconds * 1000,
      signal: context.signal,
      onTool: (name, args) => context.callTool(name, args as Json),
      onUsage: (inputTokens, outputTokens) => context.reportUsage({ inputTokens, outputTokens }),
    });
    context.reportIsolation?.(result.effectiveIsolationLevel);
    return result.output;
  }
}
