// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, generateKeyPair, signPayload, verifySigned } from '../packages/core/src/index.js';
import type { Signed } from '../packages/core/src/index.js';
import { TaskJournal } from '../packages/runtime/src/task-journal.js';
import type { TaskCheckpoint } from '../packages/runtime/src/task-journal.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'acp-task-journal-'));
  dirs.push(dir);
  const path = join(dir, 'tasks.jsonl'), owner = generateKeyPair();
  const record: TaskCheckpoint = { version: 1, taskId: 'task_journal_one', requesterDid: generateKeyPair().did,
    envelopeId: 'envelope_journal_one', proposalDigest: digest({ input: '途中の作業' }), phase: 'received', invocations: [] };
  const journal = () => new TaskJournal(path, owner);
  const records = async () => (await readFile(path, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as Signed<TaskCheckpoint>);
  return { path, owner, record, journal, records };
}

describe('task journal file recovery', () => {
  it('preserves earlier signed records when saving checkpoints across restarts', async () => {
    const f = await fixture();
    const first = f.journal();
    first.save(f.record);
    const prefix = await readFile(f.path);
    first.save({ ...f.record, phase: 'accepted' });
    f.journal().save({ ...f.record, phase: 'running' });
    const bytes = await readFile(f.path), records = await f.records();
    expect(bytes.subarray(0, prefix.length)).toEqual(prefix);
    expect(records.map((record) => record.payload.phase)).toEqual(['received', 'accepted', 'running']);
    expect(records.every((record) => verifySigned(record, f.owner.did))).toBe(true);
    const restarted = f.journal();
    restarted.load();
    expect(restarted.tasks.get(f.record.taskId)?.phase).toBe('running');
    if (process.platform !== 'win32') expect((await stat(f.path)).mode & 0o777).toBe(0o600);
  });

  it.each(['partial UTF-8', 'complete record without a newline'] as const)(
    'repairs a %s tail before saving another checkpoint', async (tail) => {
      const f = await fixture();
      f.journal().save(f.record);
      const prefix = await readFile(f.path);
      await appendFile(f.path, tail === 'partial UTF-8' ? Buffer.from([0x7b, 0x22, 0xe3, 0x81])
        : JSON.stringify(signPayload({ ...f.record, phase: 'delivered' }, f.owner)));
      const restarted = f.journal();
      restarted.load();
      expect(restarted.tasks.get(f.record.taskId)?.phase).toBe('received');
      restarted.save({ ...f.record, phase: 'accepted' });
      const next = { ...f.record, taskId: 'task_journal_two' };
      restarted.save(next);
      const bytes = await readFile(f.path), records = await f.records();
      expect(bytes.subarray(0, prefix.length)).toEqual(prefix);
      expect(records.map((record) => record.payload)).toEqual([f.record, { ...f.record, phase: 'accepted' }, next]);
      expect(records.every((record) => verifySigned(record, f.owner.did))).toBe(true);
      const recovered = f.journal();
      recovered.load();
      expect(recovered.tasks.get(f.record.taskId)?.phase).toBe('accepted');
      expect(recovered.tasks.get(next.taskId)).toEqual(next);
    });
});
