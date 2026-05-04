import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write `body` to `path` atomically: create the parent dir if missing, write
 * to `${path}.tmp`, then `rename` over the destination. A crash mid-write
 * cannot leave a half-written destination behind.
 */
export async function atomicWriteFile(path: string, body: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body);
  await rename(tmp, path);
}
