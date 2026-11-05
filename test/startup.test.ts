import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBridgeConfig } from '../src/config.js';
import { KimiHttpClient } from '../src/kimi/http.js';
import { KimiClient } from '../src/kimi/client.js';
import { KimiPreflight } from '../src/preflight.js';
import { createToolHandlers } from '../src/tools.js';
import { runToolHandler } from '../src/index.js';
import { createDefaultBaselineStore } from '../src/baseline-store.js';
import { ServerDiscovery } from '../src/server-discovery.js';

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill();
      await closed;
    }
  }
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(script: string, automatic = false) {
  const stateDir = await mkdtemp(join(tmpdir(), 'kimi-startup-'));
  directories.push(stateDir);
  const config = loadBridgeConfig({ KIMI_COMMAND: process.execPath, KIMI_SERVER_TOKEN: 'fixture-auth', KIMI_CODE_HOME: join(stateDir, 'home'), KIMI_SERVER_URL: automatic ? 'auto' : 'http://127.0.0.1:1', KIMI_BRIDGE_STATE_DIR: stateDir });
  // A real subprocess is necessary: the regression was an exit AFTER the spawn tick.
  config.kimiServerArgs = automatic ? ['web', '--no-open'] : ['-e', script];
  const http = new KimiHttpClient(config.serverUrl, fetch, 200, 'fixture-auth');
  const spawnFixture: NonNullable<import('../src/preflight.js').PreflightOptions['spawn']> = (_command, args, options) => {
      if (automatic) {
        expect(args).toEqual(['web', '--no-open', '--port', '0', '--host', '127.0.0.1']);
      }
      const child = spawn(process.execPath, ['-e', script], options);
      children.push(child);
      return child;
    };
  return { config, http, spawnFixture, preflight: new KimiPreflight(config, http, {
    startupTimeoutMs: 1500, pollIntervalMs: 20, spawn: spawnFixture,
  }) };
}

const automaticFixture = `const http=require('node:http'); const s=http.createServer((req,res)=>{
  if(req.url!='/api/v1/healthz' && req.headers.authorization!=='Bearer fixture-auth'){res.writeHead(401);res.end(JSON.stringify({code:40101,msg:'auth required',request_id:'fixture'}));return;}
  res.end(JSON.stringify({code:0,data:{default_model:'fixture'},request_id:'fixture'}));
});s.listen(0,'127.0.0.1',()=>{console.log('Bearer fixture-stdout-secret');console.log('http://127.0.0.1:'+s.address().port+'/#token=fixture-url-secret');});`;

describe('startup supervision', () => {
  it('returns a structured, secret-free early exit before the health timeout and submits no task', async () => {
    const { config, http, preflight } = await setup(`setTimeout(() => { console.log('Bearer fixture-stdout-secret'); console.error('token=fixture-stderr-secret listen EACCES 127.0.0.1:1 WinError 10013'); process.exit(7); }, 80);`);
    let submitted = false;
    const kimi = new KimiClient(http);
    kimi.createSession = async () => { submitted = true; throw new Error('must not submit'); };
    const handlers = createToolHandlers({ config, kimi, preflight });
    const start = Date.now();
    const result = await runToolHandler(() => handlers.kimi_delegate_task({ cwd: '.', task: 'do not run', plan: [], acceptanceCriteria: [] }));
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ code: 'KIMI_STARTUP_FAILED', details: { submissionState: 'not_submitted', exitCode: 7, diagnosticCodes: expect.arrayContaining(['EACCES', '10013']) } });
    expect(Date.now() - start).toBeLessThan(1400);
    expect(submitted).toBe(false);
    expect(result.content[0].text).not.toContain('fixture-stdout-secret');
    expect(result.content[0].text).not.toContain('fixture-stderr-secret');
  });

  it('also rejects a zero exit before readiness rather than waiting for health', async () => {
    const { preflight } = await setup('setTimeout(() => process.exit(0), 50)');
    const result = await runToolHandler(() => preflight.ensureReady());
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'KIMI_STARTUP_FAILED', details: { exitCode: 0 } });
  });

  it('discovers an OS-assigned port and reuses it after a bridge restart without spawning', async () => {
    const { config, preflight } = await setup(automaticFixture, true);
    const status = await preflight.ensureReady();
    expect(status).toMatchObject({ status: 'ready', healthzOk: true, authOk: true });
    expect(new URL(status.serverUrl).port).not.toBe('0');
    expect(status.serverUrl).toBe(config.serverUrl);
    const files = await readdir(config.stateDir);
    expect(files.some((file) => file.endsWith('.lock'))).toBe(false);
    const discovery = await readFile(join(config.stateDir, files.find((file) => file.startsWith('server-'))!), 'utf8');
    expect(discovery).not.toContain('fixture-');
    const restarted = loadBridgeConfig({ KIMI_SERVER_URL: 'auto', KIMI_CODE_HOME: config.kimiCodeHome, KIMI_BRIDGE_STATE_DIR: config.stateDir, KIMI_SERVER_TOKEN: 'fixture-auth' });
    const http = new KimiHttpClient(restarted.serverUrl, fetch, 200, 'fixture-auth');
    const another = new KimiPreflight(restarted, http, { spawn: () => { throw new Error('duplicate startup'); } });
    expect((await another.getStatus()).status).toBe('ready');
    expect((await another.ensureReady()).serverUrl).toBe(status.serverUrl);
    expect(children).toHaveLength(1);
  });

  it('keeps auto-mode baselines when an OS-assigned port changes', async () => {
    const { config } = await setup(automaticFixture, true);
    const baseline = { schemaVersion: 1 as const, baseCommit: 'a'.repeat(40), initialDirtyPaths: [] };
    config.serverUrl = 'http://127.0.0.1:60001';
    await createDefaultBaselineStore(config).save('fixture-session', baseline);
    config.serverUrl = 'http://127.0.0.1:60002';
    expect(await createDefaultBaselineStore(config).load('fixture-session')).toEqual(baseline);
  });

  it('refuses a fixed port mismatch before any subprocess starts', async () => {
    const { config, preflight } = await setup('process.exit(99)');
    config.kimiServerArgs = ['web', '--no-open', '--port', '58627'];
    const result = await runToolHandler(() => preflight.ensureReady());
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'KIMI_STARTUP_CONFIG_INVALID', details: { submissionState: 'not_submitted' } });
    expect(children).toHaveLength(0);
  });

  it('shares one automatic server across concurrent callers using the startup lock', async () => {
    const { config, preflight, spawnFixture } = await setup(automaticFixture, true);
    const otherConfig = { ...config };
    const another = new KimiPreflight(otherConfig, new KimiHttpClient(otherConfig.serverUrl, fetch, 200, 'fixture-auth'), {
      spawn: spawnFixture, pollIntervalMs: 20,
    });
    const results = await Promise.all([preflight.ensureReady(), another.ensureReady()]);
    expect(results[0].serverUrl).toBe(results[1].serverUrl);
    expect(results.map((result) => result.status)).toEqual(['ready', 'ready']);
    expect(children).toHaveLength(1);
  });

  it('replaces a stale discovered endpoint after its server exits', async () => {
    const { config, preflight } = await setup(automaticFixture, true);
    const first = await preflight.ensureReady();
    const child = children[0];
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
    config.preflightCacheMs = 0;
    const second = await preflight.ensureReady();
    expect(second.status).toBe('ready');
    expect(second.serverUrl).not.toBe(first.serverUrl);
    expect(children).toHaveLength(2);
  });

  it('does not let status queries redirect a startup back to its stale discovery URL', async () => {
    const { config, preflight } = await setup(automaticFixture, true);
    await preflight.ensureReady();
    const firstChild = children[0];
    const exited = new Promise((resolve) => firstChild.once('exit', resolve));
    firstChild.kill();
    await exited;
    config.preflightCacheMs = 0;
    const operation = preflight.ensureReady();
    // Interleave read-only diagnostics throughout replacement startup, including
    // the gap between advertised endpoint and authenticated discovery save.
    let done = false;
    void operation.finally(() => { done = true; }).catch(() => {});
    while (!done) { await preflight.getStatus(); await new Promise((resolve) => setTimeout(resolve, 1)); }
    const result = await operation;
    expect(result.status).toBe('ready');
    expect(result.serverUrl).toBe(config.serverUrl);
  });

  it('discards a diagnostic read that returns only after replacement startup completes', async () => {
    const { config, preflight } = await setup(automaticFixture, true);
    const first = await preflight.ensureReady();
    const exited = new Promise((resolve) => children[0].once('exit', resolve));
    children[0].kill();
    await exited;
    config.preflightCacheMs = 0;
    let completeRead!: (url: string) => void;
    const delayed = new Promise<string>((resolve) => { completeRead = resolve; });
    vi.spyOn(ServerDiscovery.prototype, 'read').mockImplementationOnce(() => delayed);
    const diagnostic = preflight.getStatus();
    const ready = await preflight.ensureReady();
    completeRead(first.serverUrl);
    expect((await diagnostic).status).toBe('ready');
    expect(config.serverUrl).toBe(ready.serverUrl);
  });

  it('does not publish an automatic endpoint that fails authentication', async () => {
    const { config, http, preflight } = await setup(automaticFixture, true);
    config.serverToken = 'wrong-fixture-token';
    config.envServerToken = 'wrong-fixture-token';
    http.setServerToken('wrong-fixture-token');
    const result = await runToolHandler(() => preflight.ensureReady());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'KIMI_AUTH_FAILED', details: { submissionState: 'not_submitted' } });
    expect((await readdir(config.stateDir)).filter((file) => file.endsWith('.json'))).toEqual([]);
  });

  it('does not accept a partial advertised port across stdout chunks', async () => {
    const script = automaticFixture.replace("console.log('http://127.0.0.1:'+s.address().port+'/#token=fixture-url-secret');", "const p=String(s.address().port);process.stdout.write('http://127.0.0.1:'+p.slice(0,2));setTimeout(()=>process.stdout.write(p.slice(2)+'/\\n'),30);");
    const { preflight } = await setup(script, true);
    expect((await preflight.ensureReady()).status).toBe('ready');
  });

  it('stops its own startup child on timeout and reports that no task was submitted', async () => {
    const { preflight } = await setup('setInterval(()=>{},1000)');
    const result = await runToolHandler(() => preflight.ensureReady());
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'KIMI_STARTUP_TIMEOUT', details: { submissionState: 'not_submitted', startupMayStillBeRunning: false } });
    expect(children[0].exitCode !== null || children[0].signalCode !== null).toBe(true);
  });
});
