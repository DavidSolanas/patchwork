import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { executeCost } from '../costCommand.js';
import type { PatchworkConfig } from '../../config/schema.js';

class CaptureStream extends Writable {
  chunks: string[] = [];
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    cb();
  }
  text(): string {
    return this.chunks.join('');
  }
}

const config: PatchworkConfig = {
  targets: [
    {
      repo: 'octo/demo',
      labels: [],
      max_issues: 2,
      max_tokens_per_issue: 100_000,
      skip_if_comments_gt: 30,
      model: 'composer-2',
    },
  ],
  settings: {
    mode: 'sequential',
    dry_run: false,
    min_score: 7,
    cost_limit_usd: 10,
  },
};

describe('executeCost', () => {
  it('prints the agent cost telemetry footnote', () => {
    const stdout = new CaptureStream() as unknown as NodeJS.WriteStream;
    executeCost(config, { stdout });
    const out = (stdout as unknown as CaptureStream).text();
    expect(out).toContain(
      'Note: Actual agent spend may show as "cost unknown" until Cursor reports token usage.',
    );
  });
});
