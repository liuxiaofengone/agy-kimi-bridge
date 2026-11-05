import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

// Windows returns EPERM/EACCES/EBUSY when antivirus, search indexers, or a
// concurrent reader briefly deny replacing an existing file. Those errors are
// transient by nature; every other error is permanent and must fail fast.
const RETRYABLE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST']);
export const ATOMIC_WRITE_MAX_ATTEMPTS = 6;

function isRetryableRenameConflict(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && RETRYABLE_CODES.has(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface AtomicWriteOptions {
  mode?: number;
}

/**
 * Atomically replace `filePath` with `contents`.
 *
 * The payload is written to a unique temporary file in the same directory and
 * then renamed over the target, so readers never observe partial JSON and the
 * previous file stays intact until the replacement succeeds. The target file
 * is never deleted first. Concurrent writers (same process or cross-process)
 * use unique temp names and race only on the final rename; the last successful
 * rename wins. Transient Windows sharing conflicts are retried with bounded
 * exponential backoff; all other errors are thrown immediately.
 */
export async function writeFileAtomic(
  filePath: string,
  contents: string,
  options?: AtomicWriteOptions,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const handle = await open(temporary, 'w', options?.mode);
        try {
          await handle.writeFile(contents, 'utf8');
          // Flush to disk before publishing so a crash mid-rename cannot leave
          // a fully renamed but half-written file behind.
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, filePath);
        return;
      } catch (error) {
        if (attempt >= ATOMIC_WRITE_MAX_ATTEMPTS - 1 || !isRetryableRenameConflict(error)) {
          throw error;
        }
        await delay(20 * 2 ** attempt + Math.floor(Math.random() * 20));
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {
      // Best-effort cleanup; a leftover temp file never corrupts the target.
    });
  }
}
