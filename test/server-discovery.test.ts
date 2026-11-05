import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadBridgeConfig } from '../src/config.js';
import { ServerDiscovery } from '../src/server-discovery.js';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function discovery() {
  const directory = await mkdtemp(join(tmpdir(), 'kimi-discovery-'));
  directories.push(directory);
  return { directory, store: new ServerDiscovery(loadBridgeConfig({ KIMI_SERVER_URL: 'auto', KIMI_CODE_HOME: directory, KIMI_BRIDGE_STATE_DIR: directory, KIMI_SERVER_TOKEN: 'fixture' })) };
}

describe('automatic discovery locks', () => {
  it('recovers empty/truncated crash records without deleting a new live owner', async () => {
    const { directory, store } = await discovery();
    const locks = `${store.file}.locks`;
    await mkdir(locks);
    // Obtain a real PID that has exited, not a guessed unused PID.
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim());
    await writeFile(join(locks, `choosing-${deadPid}-${randomUUID()}`), '');
    await writeFile(join(locks, `ticket-1-${deadPid}-${randomUUID()}`), '{"pid":');
    // Pre-upgrade shared lock garbage is no longer used as a mutex.
    await writeFile(`${store.file}.lock`, '{');
    const inside = join(directory, 'critical-section');
    await Promise.all(Array.from({ length: 5 }, async () => {
      const release = await store.lock(3000);
      let handle;
      try {
        // A second entry while any owner is active fails with EEXIST.
        handle = await open(inside, 'wx');
        await new Promise((resolve) => setTimeout(resolve, 20));
      } finally {
        if (handle) { await handle.close(); await rm(inside); }
        await release();
      }
    }));
    expect(await readdir(locks)).toEqual([]);
  });

  it('a timed-out waiter cleans only its own record and preserves a live lock', async () => {
    const { store } = await discovery();
    const release = await store.lock(1000);
    await expect(store.lock(100)).rejects.toMatchObject({ code: 'KIMI_STARTUP_LOCK_TIMEOUT' });
    expect(await readdir(`${store.file}.locks`)).toHaveLength(1);
    await release();
    const nextRelease = await store.lock(1000);
    await nextRelease();
    expect(await readdir(`${store.file}.locks`)).toEqual([]);
  });
});
