import { readFile } from 'node:fs/promises';
import { DEFERRED_QUEUE_FILE } from '../config/defaults.js';
import { dedupKey } from '../github/deduplication.js';
import type { ReviewPayload } from '../types.js';
import { atomicWriteFile } from '../util/atomicWrite.js';

export interface DeferredEntry {
  payload: ReviewPayload;
  deferredAt: string;
}

/**
 * Persistent queue of review payloads the operator chose to defer.
 *
 * Storage is a single JSON file. Writes are atomic: write to a `.tmp` sibling
 * and `rename` over the destination so a crash mid-write cannot leave a
 * truncated file behind. A corrupted/missing file is treated as an empty
 * queue — operator action (or `clear()`) is required to recover.
 */
export class DeferredQueue {
  constructor(private readonly path: string = DEFERRED_QUEUE_FILE) {}

  async push(entry: DeferredEntry): Promise<void> {
    const entries = await this.list();
    entries.push(entry);
    await this.writeAll(entries);
  }

  async list(): Promise<DeferredEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as DeferredEntry[]) : [];
    } catch {
      return [];
    }
  }

  async remove(issueKey: string): Promise<void> {
    const entries = await this.list();
    const next = entries.filter((e) => keyOf(e) !== issueKey);
    await this.writeAll(next);
  }

  async clear(): Promise<void> {
    await this.writeAll([]);
  }

  private async writeAll(entries: DeferredEntry[]): Promise<void> {
    await atomicWriteFile(this.path, JSON.stringify(entries, null, 2));
  }
}

/** Produces the `'owner/name#N'` key used by `remove()`. */
export function keyOf(entry: DeferredEntry): string {
  return dedupKey(entry.payload.issue);
}
