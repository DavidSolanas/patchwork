import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeferredQueue, keyOf, type DeferredEntry } from '../queue.js';
import type { ReviewPayload } from '../../types.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'patchwork-queue-'));
  path = join(dir, 'sub', 'deferred.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeEntry(owner: string, name: string, number: number): DeferredEntry {
  const payload = {
    issue: {
      repo: { owner, name },
      number,
      title: `issue ${number}`,
      body: 'b',
      labels: [],
      commentsCount: 0,
      assignees: [],
      htmlUrl: `https://github.com/${owner}/${name}/issues/${number}`,
      createdAt: '2026-05-01T00:00:00Z',
    },
  } as unknown as ReviewPayload;
  return { payload, deferredAt: '2026-05-01T00:00:00Z' };
}

describe('DeferredQueue', () => {
  it('returns [] when the file does not yet exist', async () => {
    const q = new DeferredQueue(path);
    expect(await q.list()).toEqual([]);
  });

  it('round-trips push → list', async () => {
    const q = new DeferredQueue(path);
    const e1 = makeEntry('o', 'r', 1);
    const e2 = makeEntry('o', 'r', 2);
    await q.push(e1);
    await q.push(e2);
    const listed = await q.list();
    expect(listed).toHaveLength(2);
    expect(listed.map(keyOf)).toEqual(['o/r#1', 'o/r#2']);
  });

  it('persists across instances (atomic file)', async () => {
    const q1 = new DeferredQueue(path);
    await q1.push(makeEntry('o', 'r', 5));
    const q2 = new DeferredQueue(path);
    expect((await q2.list()).map(keyOf)).toEqual(['o/r#5']);
  });

  it('removes by issue key', async () => {
    const q = new DeferredQueue(path);
    await q.push(makeEntry('o', 'r', 1));
    await q.push(makeEntry('o', 'r', 2));
    await q.push(makeEntry('o', 'r', 3));
    await q.remove('o/r#2');
    expect((await q.list()).map(keyOf)).toEqual(['o/r#1', 'o/r#3']);
  });

  it('remove on missing key is a no-op', async () => {
    const q = new DeferredQueue(path);
    await q.push(makeEntry('o', 'r', 1));
    await q.remove('o/r#99');
    expect((await q.list()).map(keyOf)).toEqual(['o/r#1']);
  });

  it('clear empties the queue', async () => {
    const q = new DeferredQueue(path);
    await q.push(makeEntry('o', 'r', 1));
    await q.clear();
    expect(await q.list()).toEqual([]);
  });

  it('treats a corrupted JSON file as empty', async () => {
    const corrupt = join(dir, 'corrupt.json');
    await writeFile(corrupt, 'not json', 'utf8');
    const q = new DeferredQueue(corrupt);
    expect(await q.list()).toEqual([]);
  });

  it('writes via a .tmp sibling and renames into place', async () => {
    const q = new DeferredQueue(path);
    await q.push(makeEntry('o', 'r', 1));
    // After a successful push, the .tmp file must not linger.
    await expect(readFile(`${path}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
