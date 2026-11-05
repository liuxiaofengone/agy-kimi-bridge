import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BridgeConfig } from './config.js';
import { BridgeToolError } from './errors.js';
import { writeFileAtomic } from './atomic-write.js';

export function automaticServerIdentity(config: Pick<BridgeConfig, 'kimiCodeHome'>): string {
  const path = resolve(config.kimiCodeHome ?? join(homedir(), '.kimi-code'));
  return `auto:${process.platform === 'win32' ? path.toLowerCase() : path}`;
}

export class ServerDiscovery {
  readonly file: string;
  constructor(private readonly config: BridgeConfig) {
    const key = createHash('sha256').update(automaticServerIdentity(config)).digest('hex');
    this.file = join(config.stateDir, `server-${key}.json`);
  }

  async read(): Promise<string | undefined> {
    try {
      if ((await stat(this.file)).size > 4096) return undefined;
      const value = JSON.parse(await readFile(this.file, 'utf8'));
      if (value.schemaVersion !== 1 || typeof value.serverUrl !== 'string') return undefined;
      // A discovery file can only redirect this bridge to an authenticated loopback server.
      const url = new URL(value.serverUrl);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.port === '0' ||
          url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
      return url.origin;
    } catch { return undefined; }
  }

  async save(serverUrl: string): Promise<void> {
    // The startup lock serializes bridge writers, but antivirus/indexer and
    // cross-process readers can still trigger transient Windows rename
    // conflicts; writeFileAtomic handles those without dropping atomicity.
    await writeFileAtomic(this.file, JSON.stringify({ schemaVersion: 1, serverUrl }), { mode: 0o600 });
  }

  async lock(timeoutMs: number): Promise<() => Promise<void>> {
    // Bakery mutex: each caller owns a unique file; no caller ever removes or
    // replaces a live caller's lock. A crash leaves a dead PID, not a shared
    // stale lock that multiple waiters could accidentally delete/reacquire.
    const directory = `${this.file}.locks`;
    await mkdir(directory, { recursive: true });
    const id = `${process.pid}-${randomUUID()}`;
    let ownPath = join(directory, `choosing-${id}`);
    const deadline = Date.now() + timeoutMs;
    const participants = async () => {
      const items: Array<{ name: string; id: string; ticket: number }> = [];
      for (const name of await readdir(directory)) {
        const match = /^(choosing|ticket-(\d+))-(\d+)-([0-9a-f-]{36})$/.exec(name);
        if (!match) continue;
        const pid = Number(match[3]);
        const ticket = match[1] === 'choosing' ? 0 : Number(match[2]);
        if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ticket)) continue;
        const participantId = `${pid}-${match[4]}`;
        try { process.kill(pid, 0); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            // Unique filenames cannot name a successor's lock, even with many reapers.
            await rm(join(directory, name), { force: true });
            continue;
          }
        }
        items.push({ name, id: participantId, ticket });
      }
      return items;
    };
    try {
      const handle = await open(ownPath, 'wx', 0o600);
      await handle.close();
      const ticket = 1 + Math.max(0, ...(await participants()).map((item) => item.ticket));
      const chosenPath = join(directory, `ticket-${ticket}-${id}`);
      await rename(ownPath, chosenPath);
      ownPath = chosenPath;
      while (true) {
        const ahead = (await participants()).some((item) => item.id !== id &&
          (item.ticket === 0 || item.ticket < ticket || (item.ticket === ticket && item.id < id)));
        if (!ahead) return async () => { await rm(ownPath, { force: true }); };
        if (Date.now() >= deadline) throw new BridgeToolError('KIMI_STARTUP_LOCK_TIMEOUT', 'Another bridge process is starting Kimi. Retry without submitting a duplicate task.', { submissionState: 'not_submitted' });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      await rm(ownPath, { force: true });
      throw error;
    }
  }
}
