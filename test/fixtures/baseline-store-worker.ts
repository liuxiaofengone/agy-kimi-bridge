import { FileBaselineStore } from '../../src/baseline-store.js';

// Cross-process worker for baseline-store concurrency tests. The parent test
// spawns several of these via the current Node executable and the repo-local
// tsx CLI, so saves and loads race across real processes, not just tasks.
async function main() {
  const stateDir = process.env.KIMI_BRIDGE_STATE_DIR;
  const serverUrl = process.env.KIMI_SERVER_URL;
  const sessionId = process.env.SESSION_ID;
  const baseCommit = process.env.BASE_COMMIT;
  const mode = process.env.WORKER_MODE ?? 'save';
  if (!stateDir || !serverUrl || !sessionId) {
    throw new Error('KIMI_BRIDGE_STATE_DIR, KIMI_SERVER_URL, and SESSION_ID are required');
  }

  const store = new FileBaselineStore({ stateDir, serverUrl });
  if (mode === 'save') {
    if (!baseCommit) throw new Error('BASE_COMMIT is required in save mode');
    await store.save(sessionId, { schemaVersion: 1, baseCommit, initialDirtyPaths: [] });
    process.stdout.write('saved');
    return;
  }
  process.stdout.write(JSON.stringify((await store.load(sessionId)) ?? null));
}

main().catch((error) => {
  const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(text);
  process.exit(1);
});
