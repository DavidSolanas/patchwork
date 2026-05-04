import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TerminalReviewSurface } from '../humanGate.js';
import { PatchworkError, type ReviewPayload } from '../../types.js';

interface Harness {
  surface: TerminalReviewSurface;
  stdin: PassThrough;
  stdout: PassThrough;
  output: () => string;
  openExternal: ReturnType<typeof vi.fn>;
}

function makeHarness(opts: { isTTY?: boolean } = {}): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  // Mark stdin as TTY by default so the constructor accepts it.
  Object.defineProperty(stdin, 'isTTY', { value: opts.isTTY ?? true, configurable: true });
  let buf = '';
  stdout.on('data', (c: Buffer) => { buf += c.toString('utf8'); });
  const openExternal = vi.fn().mockResolvedValue(undefined);
  const surface = new TerminalReviewSurface(
    { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream },
    { openExternal },
  );
  return { surface, stdin, stdout, output: () => buf, openExternal };
}

function makePayload(overrides: Partial<ReviewPayload> = {}): ReviewPayload {
  return {
    issue: {
      repo: { owner: 'o', name: 'r' },
      number: 7,
      title: 'thing broken',
      body: 'reproduction steps here',
      labels: ['bug'],
      commentsCount: 1,
      assignees: [],
      htmlUrl: 'https://github.com/o/r/issues/7',
      createdAt: '2026-05-01T00:00:00Z',
    },
    result: {
      issue: {} as never, // unused by surface
      outcome: {
        kind: 'success',
        branch: 'patchwork/issue-7-thing-broken',
        diff: 'diff --git a/x.ts b/x.ts\nindex 1..2 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
        commitSha: 'abc123',
        agentSummary: 'fixed it',
      },
      model: 'composer-2',
      tokens: { input: 1000, output: 200, cacheRead: 0 },
      costUsd: 0.034,
      startedAt: '2026-05-01T00:00:00Z',
      endedAt: '2026-05-01T00:01:00Z',
      cursorRunId: 'run_1',
      boundRepo: { owner: 'me', name: 'r' },
      testingNotes: 'ran npm test',
    },
    filesChanged: [{ path: 'x.ts', additions: 1, deletions: 1, binary: false }],
    totalAdditions: 1,
    totalDeletions: 1,
    largeDiffWarning: false,
    estimatedPrCostUsd: 0.034,
    ...overrides,
  };
}

// Defer until after the next microtask so the surface has had a chance to
// write its prompt and set up listeners before we feed it input.
const tick = () => new Promise((r) => setImmediate(r));

describe('TerminalReviewSurface — constructor', () => {
  it('throws PatchworkError when stdin is not a TTY', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    Object.defineProperty(stdin, 'isTTY', { value: false, configurable: true });
    expect(
      () => new TerminalReviewSurface({
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      }),
    ).toThrow(PatchworkError);
  });

  it('throws PatchworkError when stdin.isTTY is undefined (piped stdin)', () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    // Do not define isTTY at all — process.stdin reports `undefined` when piped.
    expect(
      () => new TerminalReviewSurface({
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
      }),
    ).toThrow(PatchworkError);
  });

  it('accepts a TTY stdin', () => {
    const h = makeHarness();
    expect(h.surface.interactive).toBe(true);
  });
});

describe('TerminalReviewSurface — present()', () => {
  it('returns approve on A', async () => {
    const h = makeHarness();
    const p = h.surface.present(makePayload());
    await tick();
    h.stdin.write('a');
    expect(await p).toEqual({ action: 'approve' });
  });

  it('case-insensitive key handling', async () => {
    const h = makeHarness();
    const p = h.surface.present(makePayload());
    await tick();
    h.stdin.write('A');
    expect(await p).toEqual({ action: 'approve' });
  });

  it('returns skip on S', async () => {
    const h = makeHarness();
    const p = h.surface.present(makePayload());
    await tick();
    h.stdin.write('s');
    expect(await p).toEqual({ action: 'skip' });
  });

  it('returns reject without a reason when user presses enter', async () => {
    const h = makeHarness();
    const p = h.surface.present(makePayload());
    await tick();
    h.stdin.write('r');
    await tick();
    h.stdin.write('\n');
    expect(await p).toEqual({ action: 'reject' });
  });

  it('returns reject with a reason when user types one', async () => {
    const h = makeHarness();
    const p = h.surface.present(makePayload());
    await tick();
    h.stdin.write('r');
    await tick();
    h.stdin.write('not actually broken\n');
    expect(await p).toEqual({ action: 'reject', reason: 'not actually broken' });
  });

  it('opens external URL on O then re-prompts', async () => {
    const h = makeHarness();
    const p = h.surface.present(makePayload());
    await tick();
    h.stdin.write('o');
    await tick();
    h.stdin.write('a');
    expect(await p).toEqual({ action: 'approve' });
    expect(h.openExternal).toHaveBeenCalledTimes(1);
    expect(h.openExternal).toHaveBeenCalledWith(
      'https://github.com/me/r/tree/patchwork/issue-7-thing-broken',
    );
  });

  it('re-prompts on an unknown key', async () => {
    const h = makeHarness();
    const p = h.surface.present(makePayload());
    await tick();
    h.stdin.write('z');
    await tick();
    h.stdin.write('a');
    expect(await p).toEqual({ action: 'approve' });
    expect(h.output()).toMatch(/Invalid choice/);
  });

  it('renders the large-diff banner when payload.largeDiffWarning is true', async () => {
    const h = makeHarness();
    const p = h.surface.present(makePayload({ largeDiffWarning: true }));
    await tick();
    h.stdin.write('a');
    await p;
    expect(h.output()).toMatch(/LARGE DIFF/);
  });

  it('omits the large-diff banner by default', async () => {
    const h = makeHarness();
    const p = h.surface.present(makePayload());
    await tick();
    h.stdin.write('a');
    await p;
    expect(h.output()).not.toMatch(/LARGE DIFF/);
  });

  it('strips ANSI escapes and control characters from the issue body', async () => {
    const h = makeHarness();
    const malicious = 'real text \x1b[2J\x1b[H wiped\x07\x00 here';
    const p = h.surface.present(makePayload({
      issue: { ...makePayload().issue, body: malicious, title: 'plain title' },
    }));
    await tick();
    h.stdin.write('a');
    await p;
    const out = h.output();
    expect(out).toContain('real text');
    expect(out).toContain('wiped');
    expect(out).toContain('here');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x07/);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x00/);
  });

  it('strips ANSI escapes from the issue title and labels', async () => {
    const h = makeHarness();
    const p = h.surface.present(makePayload({
      issue: {
        ...makePayload().issue,
        title: 'evil \x1b[31mtitle',
        labels: ['bug\x1b[2J'],
      },
    }));
    await tick();
    h.stdin.write('a');
    await p;
    const out = h.output();
    expect(out).toContain('evil title');
    expect(out).toContain('bug');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[31m/);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[2J/);
  });

  it('throws on Ctrl+C', async () => {
    const h = makeHarness();
    const p = h.surface.present(makePayload());
    await tick();
    h.stdin.write('\x03');
    await expect(p).rejects.toThrow(PatchworkError);
  });
});
