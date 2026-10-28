// SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair } from '../packages/core/src/index.js';
import { startLocalRelay, HttpRelayClient } from '../packages/relay/src/index.js';
import { networkCommand } from '../cli/src/network.js';

it('CLI publishes open skills, filters discovery, and settles without an invite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-open-cli-'));
  const server = await startLocalRelay({ port: 0, host: '127.0.0.1' });
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value) => lines.push(String(value)));
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let pending: Promise<void> | undefined;
  try {
    const worker = generateKeyPair(), requester = generateKeyPair();
    await writeFile(join(dir, 'worker.private.json'), JSON.stringify(worker), { mode: 0o600 });
    await writeFile(join(dir, 'requester.private.json'), JSON.stringify(requester), { mode: 0o600 });
    const common = ['--relay', server.url, '--allow-private-relay'];
    pending = networkCommand('worker', ['start', '--key', join(dir, 'worker.private.json'), ...common,
      '--open', '--publish', '--skill', 'echo', '--task-type', 'json', '--auto-accept', '--once']);
    pending.catch(() => undefined);
    const relay = new HttpRelayClient(server.url, { allowPrivateRelay: true });
    await vi.waitFor(async () => expect((await relay.discover()).length).toBe(1));
    await networkCommand('discover', [...common, '--skill', 'echo', '--task-type', 'json', '--did', worker.did]);
    const cards = JSON.parse(lines.at(-1)!);
    expect(cards[0].payload.accessMode).toBe('open');
    await networkCommand('delegate', ['--key', join(dir, 'requester.private.json'), ...common,
      '--discover', 'echo', '--task-type', 'json', '--title', 'Echo', '--description', 'Echo',
      '--input', '{"ok":true}', '--yes']);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ state: 'SETTLED', deliverable: { ok: true } });
    await pending;
  } finally {
    await server.close();
    await pending?.catch(() => undefined);
    log.mockRestore(); error.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
