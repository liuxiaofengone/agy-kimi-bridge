import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { FileBaselineStore, InMemoryBaselineStore } from '../src/baseline-store.js';
import type { GitBaseline } from '../src/git.js';

const execFileAsync = promisify(execFile);
// Cross-process workers use the current Node executable and the repo-local
// tsx CLI, never a global package manager bin directory.
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const workerFixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'baseline-store-worker.ts');

function makeBaseline(overrides: Partial<GitBaseline> = {}): GitBaseline {
  return {
    schemaVersion: 1,
    baseCommit: 'a'.repeat(40),
    baseBranch: 'main',
    initialDirtyPaths: ['src/a.ts'],
    worktrees: [{ path: '/repo', headCommit: 'a'.repeat(40) }],
    ...overrides,
  };
}

describe('FileBaselineStore', () => {
  let dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
    dirs = [];
  });

  async function tmpDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'baseline-store-test-'));
    dirs.push(dir);
    return dir;
  }

  it('saves and loads a baseline', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const baseline = makeBaseline();

    await store.save('session-1', baseline);
    const loaded = await store.load('session-1');

    expect(loaded).toEqual(baseline);
  });

  it('returns undefined for an unknown session', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });

    expect(await store.load('unknown')).toBeUndefined();
  });

  it('returns undefined for invalid file contents', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const baseline = makeBaseline();
    await store.save('session-1', baseline);

    // Corrupt the real persisted file (not a legacy layout path) and require
    // the store to reject the invalid data instead of returning it.
    const [dirName] = await readdir(stateDir);
    const file = join(stateDir, dirName, `${Buffer.from('session-1', 'utf8').toString('base64url')}.json`);
    await writeFile(file, '{"schema_version": 1, "base_commit": "not-valid"}', 'utf8');

    expect(await store.load('session-1')).toBeUndefined();
  });

  it('keeps different sessions in separate files', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const first = makeBaseline({ baseCommit: 'a'.repeat(40) });
    const second = makeBaseline({ baseCommit: 'b'.repeat(40) });

    await store.save('session-a', first);
    await store.save('session-b', second);

    expect(await store.load('session-a')).toEqual(first);
    expect(await store.load('session-b')).toEqual(second);
  });

  it('isolates baselines by server URL', async () => {
    const stateDir = await tmpDir();
    const storeA = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const storeB = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58628' });
    const baseline = makeBaseline();

    await storeA.save('session-1', baseline);

    expect(await storeA.load('session-1')).toEqual(baseline);
    expect(await storeB.load('session-1')).toBeUndefined();
  });

  it('overwrites an existing baseline for the same session', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const first = makeBaseline({ baseCommit: 'a'.repeat(40) });
    const second = makeBaseline({ baseCommit: 'b'.repeat(40) });

    await store.save('session-1', first);
    await store.save('session-1', second);

    expect(await store.load('session-1')).toEqual(second);
  });

  it('round-trips a baseline with no optional fields', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const baseline: GitBaseline = {
      schemaVersion: 1,
      baseCommit: 'c'.repeat(40),
      initialDirtyPaths: [],
    };

    await store.save('session-1', baseline);

    expect(await store.load('session-1')).toEqual(baseline);
  });

  it('filters invalid worktree entries on load', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });
    const baseline = makeBaseline({
      worktrees: [
        { path: '/repo', headCommit: 'a'.repeat(40) },
        { path: '', headCommit: 'b'.repeat(40) },
        { path: '/bad', headCommit: 'not-a-valid-id' },
        { path: '/empty-head', headCommit: '' },
      ],
    });

    await store.save('session-1', baseline);
    const loaded = await store.load('session-1');

    expect(loaded?.worktrees).toEqual([{ path: '/repo', headCommit: 'a'.repeat(40) }]);
  });

  it('uses a SHA-256 hex directory name derived from the server URL', async () => {
    const stateDir = await tmpDir();
    const serverUrl = 'http://127.0.0.1:58627';
    const store = new FileBaselineStore({ stateDir, serverUrl });

    await store.save('session-1', makeBaseline());

    const entries = await readdir(stateDir);
    expect(entries).toHaveLength(1);
    const dirName = entries[0];
    expect(dirName).toMatch(/^[0-9a-f]{64}$/);
    expect(dirName).not.toBe(Buffer.from(serverUrl, 'utf8').toString('base64url'));
  });

  it('isolates baselines by normalized server URL', async () => {
    const stateDir = await tmpDir();
    const canonicalUrl = 'http://127.0.0.1:58627';
    const variantUrl = 'HTTP://127.0.0.1:58627';
    const otherUrl = 'http://127.0.0.1:58628';
    const storeCanonical = new FileBaselineStore({ stateDir, serverUrl: canonicalUrl });
    const storeVariant = new FileBaselineStore({ stateDir, serverUrl: variantUrl });
    const storeOther = new FileBaselineStore({ stateDir, serverUrl: otherUrl });

    await storeCanonical.save('session-1', makeBaseline());

    expect(await storeVariant.load('session-1')).toEqual(await storeCanonical.load('session-1'));
    expect(await storeOther.load('session-1')).toBeUndefined();
  });

  it('preserves case and whitespace in auto data-directory identities', async () => {
    const stateDir = await tmpDir();
    // Linux data homes are case-sensitive: these are two different Kimi homes
    // and must never share one baseline partition.
    const storeCase = new FileBaselineStore({ stateDir, serverUrl: 'auto:/Case/Kimi Home' });
    const storeLower = new FileBaselineStore({ stateDir, serverUrl: 'auto:/case/kimi home' });
    const baseline = makeBaseline({ baseCommit: 'c'.repeat(40) });

    await storeCase.save('session-1', baseline);

    expect(await storeCase.load('session-1')).toEqual(baseline);
    expect(await storeLower.load('session-1')).toBeUndefined();
  });

  it('normalizes only the scheme and host of http URLs, keeping path case', async () => {
    const stateDir = await tmpDir();
    const storeA = new FileBaselineStore({ stateDir, serverUrl: 'http://EXAMPLE.com/Repo' });
    const storeB = new FileBaselineStore({ stateDir, serverUrl: 'http://example.com/Repo' });
    const storeC = new FileBaselineStore({ stateDir, serverUrl: 'http://example.com/repo' });
    const baseline = makeBaseline({ baseCommit: 'd'.repeat(40) });

    await storeA.save('session-1', baseline);

    expect(await storeB.load('session-1')).toEqual(baseline);
    // Pathnames can be case-sensitive on the server; they must stay distinct.
    expect(await storeC.load('session-1')).toBeUndefined();
  });

  it('reads baselines back across store instances like a bridge restart would', async () => {
    const stateDir = await tmpDir();
    // An auto identity survives port changes and process restarts because the
    // data home — not the ephemeral port — identifies the server.
    const identity = 'auto:/data/Kimi Home';
    const before = new FileBaselineStore({ stateDir, serverUrl: identity });
    const baseline = makeBaseline({ baseCommit: 'e'.repeat(40) });
    await before.save('session-1', baseline);

    const afterRestart = new FileBaselineStore({ stateDir, serverUrl: identity });
    expect(await afterRestart.load('session-1')).toEqual(baseline);
  });

  it('coordinates with concurrent writer processes without exposing partial JSON', async () => {
    const stateDir = await tmpDir();
    const serverUrl = 'http://127.0.0.1:58627';
    const sessionId = 'session-1';
    const warmCommit = 'f'.repeat(40);
    const commits = Array.from({ length: 6 }, (_, i) => String(i).padStart(40, '0'));
    const acceptable = new Set([warmCommit, ...commits]);

    const store = new FileBaselineStore({ stateDir, serverUrl });
    await store.save(sessionId, makeBaseline({ baseCommit: warmCommit }));

    const workerEnv = (mode: 'save' | 'read', baseCommit?: string) => ({
      ...process.env,
      KIMI_BRIDGE_STATE_DIR: stateDir,
      KIMI_SERVER_URL: serverUrl,
      SESSION_ID: sessionId,
      BASE_COMMIT: baseCommit ?? '',
      WORKER_MODE: mode,
    });

    const writers = commits.map((baseCommit) =>
      execFileAsync(process.execPath, [tsxCli, workerFixture], { env: workerEnv('save', baseCommit) }),
    );
    const inProcessReaders = Array.from({ length: 10 }, async () => {
      for (let round = 0; round < 5; round += 1) {
        const loaded = await store.load(sessionId);
        expect(loaded).toBeDefined();
        expect(acceptable.has(loaded!.baseCommit)).toBe(true);
      }
    });
    const readerProcesses = Array.from({ length: 3 }, () =>
      execFileAsync(process.execPath, [tsxCli, workerFixture], { env: workerEnv('read') }),
    );

    const [, readerOutputs] = await Promise.all([
      Promise.all([...writers, ...inProcessReaders]),
      Promise.all(readerProcesses),
    ]);
    for (const { stdout } of readerOutputs) {
      const observed = JSON.parse(stdout) as GitBaseline | null;
      expect(observed).not.toBeNull();
      expect(acceptable.has(observed!.baseCommit)).toBe(true);
    }

    const finalLoaded = await store.load(sessionId);
    expect(finalLoaded).toBeDefined();
    expect(acceptable.has(finalLoaded!.baseCommit)).toBe(true);
  });

  it('survives concurrent saves for the same session', async () => {
    const stateDir = await tmpDir();
    const store = new FileBaselineStore({ stateDir, serverUrl: 'http://127.0.0.1:58627' });

    const baselines: GitBaseline[] = Array.from({ length: 10 }, (_, i) =>
      makeBaseline({ baseCommit: String(i).padStart(40, '0') }),
    );

    await Promise.all(baselines.map((baseline) => store.save('session-1', baseline)));

    const loaded = await store.load('session-1');
    expect(loaded).toBeDefined();
    expect(baselines.map((b) => b.baseCommit)).toContain(loaded!.baseCommit);
  });

  it('survives concurrent saves from separate store instances racing one file', async () => {
    const stateDir = await tmpDir();
    const serverUrl = 'http://127.0.0.1:58627';
    const instances = Array.from({ length: 4 }, () => new FileBaselineStore({ stateDir, serverUrl }));

    const baselines: GitBaseline[] = Array.from({ length: 16 }, (_, i) =>
      makeBaseline({ baseCommit: String(i).padStart(40, '0') }),
    );

    await Promise.all(baselines.map((baseline, i) => instances[i % instances.length].save('session-1', baseline)));

    const loaded = await new FileBaselineStore({ stateDir, serverUrl }).load('session-1');
    expect(loaded).toBeDefined();
    expect(baselines.map((b) => b.baseCommit)).toContain(loaded!.baseCommit);
  });

  it('never exposes partial JSON to concurrent readers and leaves no temp files', async () => {
    const stateDir = await tmpDir();
    const serverUrl = 'http://127.0.0.1:58627';
    const store = new FileBaselineStore({ stateDir, serverUrl });
    const commits = Array.from({ length: 20 }, (_, i) => String(i).padStart(40, '0'));

    const saves = commits.map((baseCommit) => store.save('session-1', makeBaseline({ baseCommit })));
    // Assert every single read individually: each observation must be either
    // "no file yet" (before the first save lands) or a complete, valid
    // baseline — never partial JSON and never a lost record.
    const reads = Array.from({ length: 20 }, async () => {
      for (let round = 0; round < 10; round += 1) {
        const loaded = await store.load('session-1');
        if (loaded !== undefined) {
          expect(commits).toContain(loaded.baseCommit);
          expect(loaded.schemaVersion).toBe(1);
        }
      }
    });
    await Promise.all([...saves, ...reads]);

    const loaded = await store.load('session-1');
    expect(loaded).toBeDefined();
    expect(commits).toContain(loaded!.baseCommit);

    const [partition] = await readdir(stateDir);
    const entries = await readdir(join(stateDir, partition));
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(entries).toContain(Buffer.from('session-1', 'utf8').toString('base64url') + '.json');
  });

  it('never loses the warmed baseline while writers race to replace it', async () => {
    const stateDir = await tmpDir();
    const serverUrl = 'http://127.0.0.1:58627';
    const store = new FileBaselineStore({ stateDir, serverUrl });
    const warmCommit = 'f'.repeat(40);
    const newCommits = Array.from({ length: 8 }, (_, i) => String(i).padStart(40, '0'));
    const acceptable = new Set([warmCommit, ...newCommits]);

    // Warm an existing baseline first. A delete-before-rename implementation
    // would surface reads as undefined; readers must always observe the old
    // or one of the new complete baselines.
    await store.save('session-1', makeBaseline({ baseCommit: warmCommit }));

    const writers = newCommits.map((baseCommit) => store.save('session-1', makeBaseline({ baseCommit })));
    const readers = Array.from({ length: 12 }, async () => {
      for (let round = 0; round < 10; round += 1) {
        const loaded = await store.load('session-1');
        expect(loaded).toBeDefined();
        expect(acceptable.has(loaded!.baseCommit)).toBe(true);
      }
    });
    await Promise.all([...writers, ...readers]);

    const loaded = await store.load('session-1');
    expect(loaded).toBeDefined();
    expect(acceptable.has(loaded!.baseCommit)).toBe(true);
  });
});

describe('InMemoryBaselineStore', () => {
  it('saves and loads baselines in memory', async () => {
    const store = new InMemoryBaselineStore();
    const baseline = makeBaseline();

    await store.save('session-1', baseline);

    expect(await store.load('session-1')).toEqual(baseline);
    expect(await store.load('session-2')).toBeUndefined();
  });
});
