import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Canonical comparison key for workspace/cwd paths.
 *
 * Centralizes the platform rules so dedupe cwd matching and git worktree
 * matching agree:
 *
 * - Windows: both slash styles are accepted, `.`/`..` segments collapse, the
 *   drive letter is lowercased together with the rest of the path (Windows
 *   file systems are case-insensitive), and trailing separators are stripped
 *   except on filesystem roots (`C:\`, `\\server\share`).
 * - POSIX: only `/` separators, trailing separators stripped except for the
 *   `/` root, and case is preserved (POSIX file systems are case-sensitive).
 *
 * The `platform` parameter exists so tests can exercise both rule sets on any
 * host; production callers use the default.
 */
export function normalizeWorkspacePathForCompare(
  input: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // Never trim: leading/trailing whitespace is legal in POSIX directory names,
  // and '/repo' vs '/repo ' are different projects that must not dedupe together.
  if (platform === 'win32') {
    const unified = input.replace(/\//g, '\\');
    let normalized = path.win32.normalize(unified);
    const root = path.win32.parse(normalized).root;
    if (normalized.length > root.length) {
      normalized = normalized.replace(/[\\/]+$/, '');
    } else if (root.endsWith('\\') && root.length > 3) {
      // UNC share root: keep the share itself but drop the trailing separator.
      normalized = root.slice(0, -1);
    }
    return normalized.toLowerCase();
  }
  let normalized = path.posix.normalize(input);
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Resolve a path (for example from `git worktree list`, which prints forward
 * slashes even on Windows) to the canonical native absolute path used in
 * tool output. Symlinks are resolved when possible; otherwise the path is
 * resolved against the current working directory with native separators.
 */
export async function toCanonicalNativePath(input: string): Promise<string> {
  try {
    return await realpath(input);
  } catch {
    return path.resolve(input);
  }
}
