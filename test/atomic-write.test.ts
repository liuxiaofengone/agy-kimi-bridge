import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATOMIC_WRITE_MAX_ATTEMPTS, writeFileAtomic } from '../src/atomic-write.js';

// Only the underlying fs boundary is mocked (rename/rm wrappers around the
// real implementations); the atomic-write helper logic under test is real.
const hoisted = vi.hoisted(() => ({ originalRename: undefined as unknown }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  hoisted.originalRename = actual.rename;
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});

const mockedRename = vi.mocked(rename);

function eperm(): NodeJS.ErrnoException {
  const error = new Error('operation not permitted, rename') as NodeJS.ErrnoException;
  error.code = 'EPERM';
  return error;
}

describe('writeFileAtomic failure boundaries', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    mockedRename.mockClear();
    mockedRename.mockImplementation(hoisted.originalRename as typeof rename);
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    dirs = [];
  });

  async function tmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-write-test-'));
    dirs.push(dir);
    return dir;
  }

  it('keeps the previous file, cleans the temp file, and stops retrying when EPERM persists', async () => {
    const dir = await tmpDir();
    const target = join(dir, 'baseline.json');
    await writeFileAtomic(target, '{"old":true}');
    mockedRename.mockClear();

    mockedRename.mockImplementation(() => Promise.reject(eperm()));

    await expect(writeFileAtomic(target, '{"new":true}')).rejects.toMatchObject({ code: 'EPERM' });
    // Bounded: the persistent conflict must not loop forever.
    expect(mockedRename).toHaveBeenCalledTimes(ATOMIC_WRITE_MAX_ATTEMPTS);
    // The previous file is intact — the target was never deleted first.
    await expect(readFile(target, 'utf8')).resolves.toBe('{"old":true}');
    // No leftover temp files after cleanup.
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('fails fast on non-retryable errors', async () => {
    const dir = await tmpDir();
    const target = join(dir, 'baseline.json');
    mockedRename.mockImplementation(() => {
      const error = new Error('no such file or directory') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return Promise.reject(error);
    });
    mockedRename.mockClear();

    await expect(writeFileAtomic(target, '{"new":true}')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mockedRename).toHaveBeenCalledTimes(1);
  });

  it('recovers when a transient EPERM clears during the bounded retries', async () => {
    const dir = await tmpDir();
    const target = join(dir, 'baseline.json');
    mockedRename
      .mockRejectedValueOnce(eperm())
      .mockRejectedValueOnce(eperm());
    mockedRename.mockClear();

    await writeFileAtomic(target, '{"recovered":true}');
    expect(mockedRename).toHaveBeenCalledTimes(3);
    await expect(readFile(target, 'utf8')).resolves.toBe('{"recovered":true}');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
