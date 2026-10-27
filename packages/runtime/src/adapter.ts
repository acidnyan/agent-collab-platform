// SPDX-License-Identifier: Apache-2.0
import type { AgentSkill, Json, TaskManifest } from '@acp/core';
export interface UsageMetrics {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCalls: number;
  wallTimeMs: number;
}
export interface ProgressMetrics {
  inputTokens?: number;
  outputTokens?: number;
  toolInvocations?: number;
  elapsedMs?: number;
}
export interface ProgressPayload {
  percent?: number;
  step: string;
  message?: string;
  metrics?: ProgressMetrics;
}
export interface ProtocolEnvelope<T> {
  taskId: string;
  seq: number;
  eventType: string;
  senderDid: string;
  recipientDid: string;
  payload: T;
}
export interface AgentTaskContext {
  taskId: string;
  manifest: TaskManifest;
  input: Json;
  callTool: (tool: string, args: Json) => Promise<Json>;
  reportUsage: (delta: Partial<UsageMetrics>) => void;
  reportProgress?: (progress: ProgressPayload) => void | Promise<void>;
  signal: AbortSignal;
  workspaceDir: string;
  reportIsolation?: (level: string) => void;
}
export interface AgentAdapter {
  id: string;
  name: string;
  skills: AgentSkill[];
  executeTask(context: AgentTaskContext): Promise<Json>;
}
