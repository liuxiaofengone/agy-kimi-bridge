import { describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeWorkspacePathForCompare, toCanonicalNativePath } from '../src/paths.js';

describe('normalizeWorkspacePathForCompare', () => {
  describe('win32 rules', () => {
    const win = (input: string) => normalizeWorkspacePathForCompare(input, 'win32');

    it('treats forward and backward slashes as the same path', () => {
      expect(win('C:/repo/feature/')).toBe(win('C:\\repo\\feature'));
      expect(win('c:\\repo\\feature')).toBe(win('C:/REPO/FEATURE'));
    });

    it('strips trailing separators but keeps filesystem roots', () => {
      expect(win('C:\\repo\\')).toBe('c:\\repo');
      expect(win('C:/')).toBe('c:\\');
      expect(win('\\\\server\\share\\')).toBe('\\\\server\\share');
    });

    it('collapses dot segments', () => {
      expect(win('C:\\repo\\feature\\..\\feature')).toBe(win('C:\\repo\\feature'));
    });

    it('keeps distinct projects distinct', () => {
      expect(win('C:\\repo\\feature')).not.toBe(win('C:\\repo\\feature-2'));
      expect(win('C:\\repo')).not.toBe(win('D:\\repo'));
    });

    it('treats drive-relative root paths consistently', () => {
      expect(win('\\repo\\')).toBe(win('/repo'));
    });

    it('does not trim significant whitespace', () => {
      expect(win('C:\\repo ')).toBe('c:\\repo ');
      expect(win('C:\\repo')).not.toBe(win('C:\\repo '));
      // A leading space makes the path relative on Windows; it must still not
      // collapse onto the absolute variant.
      expect(win(' C:\\repo')).not.toBe(win('C:\\repo'));
    });
  });

  describe('posix rules', () => {
    const posix = (input: string) => normalizeWorkspacePathForCompare(input, 'darwin');

    it('strips trailing separators but keeps the root', () => {
      expect(posix('/repo/')).toBe('/repo');
      expect(posix('/')).toBe('/');
    });

    it('preserves case because POSIX file systems are case-sensitive', () => {
      expect(posix('/Repo')).toBe('/Repo');
      expect(posix('/Repo')).not.toBe(posix('/repo'));
    });

    it('collapses dot segments', () => {
      expect(posix('/repo/feature/../feature')).toBe('/repo/feature');
    });

    it('treats backslash as a literal filename character, not a separator', () => {
      expect(posix('/repo/Feature\\X')).toBe('/repo/Feature\\X');
      expect(posix('/repo/Feature\\X')).not.toBe(posix('/repo/Feature/X'));
    });

    it('does not trim significant whitespace', () => {
      expect(posix('/repo ')).toBe('/repo ');
      expect(posix('/repo')).not.toBe(posix('/repo '));
      expect(posix(' /repo')).toBe(' /repo');
      expect(posix('/repo\n')).toBe('/repo\n');
    });
  });
});

describe('toCanonicalNativePath', () => {
  it('resolves symlinks to the native realpath for existing paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'paths-test-'));
    try {
      const canonical = await toCanonicalNativePath(dir);
      expect(canonical).toBe(await realpath(dir));
      expect(canonical).not.toMatch(/[\\/]\.{1,2}[\\/]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to a resolved native path when the target does not exist', async () => {
    const missing = join(tmpdir(), 'paths-test-missing-dir', 'nested');
    const canonical = await toCanonicalNativePath(missing);
    expect(canonical.endsWith(join('paths-test-missing-dir', 'nested'))).toBe(true);
  });
});
