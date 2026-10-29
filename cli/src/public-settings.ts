// SPDX-License-Identifier: Apache-2.0
import type { SignedAgentCard } from '@acp/core';
export interface PublicSettings {
  public: boolean;
  taskTypes: string[];
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxWallSeconds: number;
  maxJobsPerPersonPerMinute: number;
  maxJobsPerDay: number;
  alwaysAsk: boolean;
}
export function publicSettingsFlags(s: PublicSettings): string[] {
  if (!s || Object.keys(s).sort().join(',') !== ['public','taskTypes','maxInputTokens','maxOutputTokens',
      'maxToolCalls','maxWallSeconds','maxJobsPerPersonPerMinute','maxJobsPerDay','alwaysAsk'].sort().join(',') ||
      typeof s.public !== 'boolean' || typeof s.alwaysAsk !== 'boolean' || !Array.isArray(s.taskTypes) || !s.taskTypes.length ||
      s.taskTypes.some(t => typeof t !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(t))) throw new Error('INVALID_PUBLIC_SETTINGS');
  const mapping = { maxInputTokens: 'open-max-input-tokens', maxOutputTokens: 'open-max-output-tokens',
    maxToolCalls: 'open-max-tool-calls', maxWallSeconds: 'open-max-wall-seconds',
    maxJobsPerPersonPerMinute: 'open-rate-limit-per-did', maxJobsPerDay: 'max-tasks-per-day' } as const;
  for (const field of Object.keys(mapping) as (keyof typeof mapping)[])
    if (!Number.isSafeInteger(s[field]) || s[field] < 1) throw new Error('INVALID_PUBLIC_SETTINGS');
  const flags = ['--max-tasks-per-day', String(s.maxJobsPerDay)];
  if (!s.public) return flags;
  flags.push('--open', '--publish', '--open-allow-task-type', [...new Set(s.taskTypes)].join(','));
  for (const field of Object.keys(mapping) as (keyof typeof mapping)[])
    if (field !== 'maxJobsPerDay') flags.push('--' + mapping[field], String(s[field]));
  // Explicit false is the existing G3 opt-in; absence never implies auto-accept.
  if (!s.alwaysAsk) flags.push('--auto-accept', '--allow-any-requester');
  return flags;
}
export function publicProfileSummary(card: SignedAgentCard, rate?: number, daily?: number, automatic = false) {
  return { name: card.payload.name, access: card.payload.accessMode === 'open' ? 'Strangers may request jobs' : 'Invite only',
    jobs: card.payload.skills.flatMap(s => s.taskTypes ?? []), perJob: card.payload.openPolicy ?? {},
    hostLimits: { perPersonPerMinute: rate ?? null, perDay: daily ?? null, dayReset: '00:00 UTC' },
    approval: automatic ? 'Automatic acceptance explicitly enabled' : 'Owner approval required',
    notice: 'Host rate and daily limits are not advertised in the signed openPolicy. Available capacity is checked at admission.',
    signedCard: card };
}
