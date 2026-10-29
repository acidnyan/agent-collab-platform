// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Host-wide UTC admission counter. Lock contention and corrupt state fail closed. */
export function consumeDailyTask(path: string, limit: number, taskId: string, now = Date.now()): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(now) || !taskId)
    throw new Error('INVALID_DAILY_LIMIT');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = path + '.lock', temporary = path + '.' + randomUUID() + '.tmp';
  try { writeFileSync(lock, '', { flag: 'wx', mode: 0o600 }); }
  catch { throw new Error('DAILY_LIMIT_BUSY: retry later; never remove a live lock'); }
  try {
    const day = new Date(now).toISOString().slice(0, 10);
    let state: { version: number; day: string; tasks: string[] } = { version: 1, day, tasks: [] };
    try { state = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('DAILY_LIMIT_INVALID'); }
    if (state.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(state.day) ||
        !Array.isArray(state.tasks) || state.tasks.some(t => typeof t !== 'string') ||
        new Set(state.tasks).size !== state.tasks.length) throw new Error('DAILY_LIMIT_INVALID');
    if (day < state.day) throw new Error('DAILY_LIMIT_CLOCK_ROLLBACK');
    if (day > state.day) state = { version: 1, day, tasks: [] };
    if (state.tasks.includes(taskId)) throw new Error('DAILY_TASK_REPLAY');
    if (state.tasks.length >= limit) throw new Error('DAILY_LIMIT_REACHED');
    state.tasks.push(taskId);
    writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    unlinkSync(lock);
  }
}
