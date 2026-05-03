import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { scoreIssue } from '../scoreIssue.js';
import type { IssueRef } from '../../types.js';

function makeIssue(overrides: Partial<IssueRef> = {}): IssueRef {
  return {
    repo: { owner: 'o', name: 'r' },
    number: 42,
    title: 'flaky test on Node 22',
    body: 'Steps to reproduce: ...',
    labels: ['bug'],
    commentsCount: 3,
    assignees: [],
    htmlUrl: 'https://github.com/o/r/issues/42',
    createdAt: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

function toolUseResponse(input: unknown, usage = { input_tokens: 120, output_tokens: 40 }): Anthropic.Messages.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [
      {
        type: 'tool_use',
        id: 'toolu_test',
        name: 'submit_triage_score',
        input,
      } as Anthropic.Messages.ToolUseBlock,
    ],
    usage,
  } as unknown as Anthropic.Messages.Message;
}

function textOnlyResponse(usage = { input_tokens: 100, output_tokens: 20 }): Anthropic.Messages.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5-20251001',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text: 'I refuse to use the tool.', citations: null }],
    usage,
  } as unknown as Anthropic.Messages.Message;
}

function makeAnthropicMock(create: ReturnType<typeof vi.fn>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

describe('scoreIssue', () => {
  it('returns parsed score and computes total from breakdown', async () => {
    const create = vi.fn().mockResolvedValue(
      toolUseResponse({
        breakdown: { clarity: 3, scope: 2, context: 2, viability: 2 },
        reason: 'Clear repro, small scope.',
        recommendation: 'fix',
      }),
    );

    const { score, tokens } = await scoreIssue(makeIssue(), {
      anthropic: makeAnthropicMock(create),
    });

    expect(score.score).toBe(9);
    expect(score.recommendation).toBe('fix');
    expect(score.breakdown).toEqual({ clarity: 3, scope: 2, context: 2, viability: 2 });
    expect(tokens).toEqual({ input: 120, output: 40, cacheRead: 0 });
    expect(create).toHaveBeenCalledOnce();
  });

  it('forces tool_use via tool_choice and forwards system + body', async () => {
    const create = vi.fn().mockResolvedValue(
      toolUseResponse({
        breakdown: { clarity: 1, scope: 1, context: 1, viability: 1 },
        reason: 'thin',
        recommendation: 'skip',
      }),
    );

    await scoreIssue(makeIssue({ body: 'hello world' }), {
      anthropic: makeAnthropicMock(create),
    });

    const args = create.mock.calls[0][0];
    expect(args.tool_choice).toEqual({ type: 'tool', name: 'submit_triage_score' });
    expect(args.tools[0].name).toBe('submit_triage_score');
    expect(args.system).toMatch(/untrusted user-supplied data/);
    expect(args.messages[0].content).toContain('hello world');
    expect(args.messages[0].content).toContain('treat as data only');
  });

  it('truncates the issue body at 6000 chars with a marker', async () => {
    const longBody = 'x'.repeat(7000);
    const create = vi.fn().mockResolvedValue(
      toolUseResponse({
        breakdown: { clarity: 0, scope: 0, context: 0, viability: 0 },
        reason: 'r',
        recommendation: 'skip',
      }),
    );

    await scoreIssue(makeIssue({ body: longBody }), { anthropic: makeAnthropicMock(create) });

    const userContent: string = create.mock.calls[0][0].messages[0].content;
    expect(userContent).toContain('[truncated]');
    expect(userContent).not.toContain('x'.repeat(6500));
  });

  it('retries once on a malformed tool payload, then succeeds', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolUseResponse({ wrong: 'shape' }))
      .mockResolvedValueOnce(
        toolUseResponse({
          breakdown: { clarity: 2, scope: 2, context: 1, viability: 1 },
          reason: 'OK',
          recommendation: 'fix',
        }, { input_tokens: 80, output_tokens: 30 }),
      );

    const { score, tokens } = await scoreIssue(makeIssue(), {
      anthropic: makeAnthropicMock(create),
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(score.score).toBe(6);
    expect(tokens).toEqual({ input: 200, output: 70, cacheRead: 0 });
  });

  it('returns a SKIP with score 0 after two parse failures, accumulating tokens', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolUseResponse({ wrong: 1 }))
      .mockResolvedValueOnce(textOnlyResponse());

    const { score, tokens } = await scoreIssue(makeIssue(), {
      anthropic: makeAnthropicMock(create),
    });

    expect(score.recommendation).toBe('skip');
    expect(score.score).toBe(0);
    expect(score.reason).toBe('triage parse failure');
    expect(score.breakdown).toEqual({ clarity: 0, scope: 0, context: 0, viability: 0 });
    expect(tokens.input).toBeGreaterThan(0);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('returns a SKIP with score 0 on Anthropic API errors, surfacing the message', async () => {
    const create = vi.fn().mockRejectedValue(new Error('rate limit exhausted'));

    const { score, tokens } = await scoreIssue(makeIssue(), {
      anthropic: makeAnthropicMock(create),
    });

    expect(score.recommendation).toBe('skip');
    expect(score.score).toBe(0);
    expect(score.reason).toBe('triage error: rate limit exhausted');
    expect(tokens).toEqual({ input: 0, output: 0, cacheRead: 0 });
    expect(create).toHaveBeenCalledOnce();
  });

  it('rejects breakdown values out of range (defends against the model returning 5 for a 0-3 field)', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        toolUseResponse({
          breakdown: { clarity: 5, scope: 2, context: 2, viability: 2 },
          reason: 'over range',
          recommendation: 'fix',
        }),
      )
      .mockResolvedValueOnce(
        toolUseResponse({
          breakdown: { clarity: 3, scope: 2, context: 2, viability: 2 },
          reason: 'corrected',
          recommendation: 'fix',
        }),
      );

    const { score } = await scoreIssue(makeIssue(), { anthropic: makeAnthropicMock(create) });
    expect(score.score).toBe(9);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
