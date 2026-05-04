import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { preflight } from '../preflight.js';
import { PatchworkError } from '../../types.js';

function ttyStream(isTTY: boolean | undefined): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream;
  if (isTTY === undefined) return s;
  Object.defineProperty(s, 'isTTY', { value: isTTY, configurable: true });
  return s;
}

const FULL_ENV: NodeJS.ProcessEnv = {
  GITHUB_TOKEN: 'ghp_x',
  ANTHROPIC_API_KEY: 'sk-ant-x',
  CURSOR_API_KEY: 'cur_x',
};

describe('preflight', () => {
  it('passes for a TTY full run with all env vars', () => {
    expect(() =>
      preflight({
        needsTty: true,
        needsCursor: true,
        env: FULL_ENV,
        stdin: ttyStream(true),
        nodeVersion: '22.5.0',
      }),
    ).not.toThrow();
  });

  it('rejects Node < 22', () => {
    expect(() =>
      preflight({
        needsTty: true,
        needsCursor: true,
        env: FULL_ENV,
        stdin: ttyStream(true),
        nodeVersion: '20.0.0',
      }),
    ).toThrow(PatchworkError);
  });

  it('refuses non-TTY when needsTty is true', () => {
    let err: unknown = null;
    try {
      preflight({
        needsTty: true,
        needsCursor: true,
        env: FULL_ENV,
        stdin: ttyStream(undefined),
        nodeVersion: '22.0.0',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PatchworkError);
    expect((err as PatchworkError).message).toMatch(/interactive terminal/);
  });

  it('allows non-TTY when needsTty is false', () => {
    expect(() =>
      preflight({
        needsTty: false,
        needsCursor: false,
        env: { GITHUB_TOKEN: 'x', ANTHROPIC_API_KEY: 'y' },
        stdin: ttyStream(false),
        nodeVersion: '22.0.0',
      }),
    ).not.toThrow();
  });

  it('requires GITHUB_TOKEN', () => {
    expect(() =>
      preflight({
        needsTty: false,
        needsCursor: false,
        env: { ANTHROPIC_API_KEY: 'y' },
        stdin: ttyStream(true),
        nodeVersion: '22.0.0',
      }),
    ).toThrow(/GITHUB_TOKEN/);
  });

  it('requires ANTHROPIC_API_KEY by default', () => {
    expect(() =>
      preflight({
        needsTty: false,
        needsCursor: false,
        env: { GITHUB_TOKEN: 'x' },
        stdin: ttyStream(true),
        nodeVersion: '22.0.0',
      }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('skips ANTHROPIC_API_KEY when needsAnthropic is false', () => {
    expect(() =>
      preflight({
        needsTty: false,
        needsCursor: false,
        needsAnthropic: false,
        env: { GITHUB_TOKEN: 'x' },
        stdin: ttyStream(true),
        nodeVersion: '22.0.0',
      }),
    ).not.toThrow();
  });

  it('requires CURSOR_API_KEY when needsCursor is true', () => {
    expect(() =>
      preflight({
        needsTty: true,
        needsCursor: true,
        env: { GITHUB_TOKEN: 'x', ANTHROPIC_API_KEY: 'y' },
        stdin: ttyStream(true),
        nodeVersion: '22.0.0',
      }),
    ).toThrow(/CURSOR_API_KEY/);
  });

  it('does not require CURSOR_API_KEY when needsCursor is false', () => {
    expect(() =>
      preflight({
        needsTty: false,
        needsCursor: false,
        env: { GITHUB_TOKEN: 'x', ANTHROPIC_API_KEY: 'y' },
        stdin: ttyStream(true),
        nodeVersion: '22.0.0',
      }),
    ).not.toThrow();
  });

  it('treats whitespace-only env vars as missing', () => {
    expect(() =>
      preflight({
        needsTty: false,
        needsCursor: false,
        env: { GITHUB_TOKEN: '   ', ANTHROPIC_API_KEY: 'y' },
        stdin: ttyStream(true),
        nodeVersion: '22.0.0',
      }),
    ).toThrow(/GITHUB_TOKEN/);
  });
});
