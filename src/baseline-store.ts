import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { OBJECT_ID_RE, type GitBaseline } from './git.js';
import { automaticServerIdentity } from './server-discovery.js';
import { writeFileAtomic } from './atomic-write.js';

export interface BaselineStore {
  save(sessionId: string, baseline: GitBaseline): Promise<void>;
  load(sessionId: string): Promise<GitBaseline | undefined>;
}

export interface FileBaselineStoreOptions {
  stateDir: string;
  serverUrl: string;
}

function safeFileName(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function normalizeServerUrl(input: string): string {
  // Data-directory identities (auto:) are produced by automaticServerIdentity
  // and must be compared byte-exactly: POSIX data paths are case- and
  // whitespace-sensitive, and Windows identities are already lowercased there.
  // Lowercasing them here would merge distinct Linux homes such as
  // '/Case/Home' and '/case/home' into one baseline partition.
  if (input.toLowerCase().startsWith('auto:')) {
    return input;
  }
  try {
    const url = new URL(input);
    // Only the scheme and host are case-insensitive. The path, query, and
    // fragment are preserved verbatim so distinct endpoints are never merged.
    // For common root URLs (no path) the result is byte-identical to the
    // legacy whole-string lowercase normalization, so existing baselines keep
    // resolving after an upgrade.
    const path = url.pathname === '/' ? '' : url.pathname;
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${path}${url.search}${url.hash}`;
  } catch {
    return input.trim().toLowerCase();
  }
}

function serverDirName(serverUrl: string): string {
  return createHash('sha256').update(normalizeServerUrl(serverUrl), 'utf8').digest('hex');
}

export class FileBaselineStore implements BaselineStore {
  private readonly serverDir: string;

  constructor(options: FileBaselineStoreOptions) {
    this.serverDir = join(options.stateDir, serverDirName(options.serverUrl));
  }

  private filePath(sessionId: string): string {
    return join(this.serverDir, `${safeFileName(sessionId)}.json`);
  }

  async save(sessionId: string, baseline: GitBaseline): Promise<void> {
    const payload: Record<string, unknown> = {
      schema_version: baseline.schemaVersion,
      base_commit: baseline.baseCommit,
      initial_dirty_paths: baseline.initialDirtyPaths,
    };
    if (baseline.baseBranch) {
      payload.base_branch = baseline.baseBranch;
    }
    if (baseline.worktrees) {
      payload.worktrees = baseline.worktrees.map((wt) => ({
        path: wt.path,
        head_commit: wt.headCommit,
      }));
    }

    await writeFileAtomic(this.filePath(sessionId), JSON.stringify(payload));
  }

  async load(sessionId: string): Promise<GitBaseline | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(sessionId), 'utf8');
    } catch {
      return undefined;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }

    if (parsed.schema_version !== 1) return undefined;

    const baseCommit = typeof parsed.base_commit === 'string' ? parsed.base_commit : undefined;
    if (!baseCommit || !OBJECT_ID_RE.test(baseCommit)) return undefined;

    const baseBranch = typeof parsed.base_branch === 'string' ? parsed.base_branch : undefined;
    const initialDirtyPaths = Array.isArray(parsed.initial_dirty_paths)
      ? parsed.initial_dirty_paths.filter((p): p is string => typeof p === 'string')
      : [];

    const worktreesRaw = parsed.worktrees;
    const worktrees = Array.isArray(worktreesRaw)
      ? worktreesRaw
          .map((item) => {
            if (!item || typeof item !== 'object') return undefined;
            const wt = item as Record<string, unknown>;
            const wtPath = typeof wt.path === 'string' ? wt.path : undefined;
            const headCommit = typeof wt.head_commit === 'string' ? wt.head_commit : undefined;
            if (!wtPath || wtPath.length === 0 || !headCommit || !OBJECT_ID_RE.test(headCommit)) {
              return undefined;
            }
            return { path: wtPath, headCommit };
          })
          .filter((wt): wt is NonNullable<typeof wt> => wt !== undefined)
      : undefined;

    return {
      schemaVersion: 1,
      baseCommit,
      baseBranch,
      initialDirtyPaths,
      worktrees,
    };
  }
}

export class InMemoryBaselineStore implements BaselineStore {
  private readonly data = new Map<string, GitBaseline>();

  async save(sessionId: string, baseline: GitBaseline): Promise<void> {
    this.data.set(sessionId, baseline);
  }

  async load(sessionId: string): Promise<GitBaseline | undefined> {
    return this.data.get(sessionId);
  }
}

export function createDefaultBaselineStore(config: { stateDir: string; serverUrl: string; autoServer?: boolean; kimiCodeHome?: string }): BaselineStore {
  return new FileBaselineStore({ stateDir: config.stateDir, serverUrl: config.autoServer ? automaticServerIdentity(config) : config.serverUrl });
}
