import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BridgeConfig } from './config.js';
import { BridgeToolError } from './errors.js';

export type StartupSpawn = (command: string, args: readonly string[], options: {
  detached: boolean; stdio: ['ignore', 'pipe', 'pipe']; windowsHide: boolean; env: NodeJS.ProcessEnv;
}) => ChildProcess;

export function startupArgs(config: BridgeConfig): string[] {
  const args = [...(config.kimiServerArgs ?? ['server', 'run', '--keep-alive'])];
  if (args[0] !== 'web') {
    if (config.autoServer) throw new BridgeToolError('KIMI_STARTUP_CONFIG_INVALID', 'Automatic ports require kimi web.', { submissionState: 'not_submitted' });
    return args;
  }
  const port = config.autoServer ? '0' : (new URL(config.serverUrl).port || (config.serverUrl.startsWith('https:') ? '443' : '80'));
  let portFound = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port' || args[i].startsWith('--port=')) {
      const value = args[i] === '--port' ? args[++i] : args[i].slice(7);
      if (portFound || value !== port) throw new BridgeToolError('KIMI_STARTUP_CONFIG_INVALID', 'KIMI_SERVER_ARGS port must match KIMI_SERVER_URL (use port 0 in automatic mode).', { submissionState: 'not_submitted' });
      portFound = true;
    }
    if (config.autoServer && (args[i] === '--host' || args[i].startsWith('--host='))) {
      throw new BridgeToolError('KIMI_STARTUP_CONFIG_INVALID', 'Automatic mode manages the loopback bind host.', { submissionState: 'not_submitted' });
    }
  }
  if (!portFound) args.push('--port', port);
  if (config.autoServer) args.push('--host', '127.0.0.1');
  return args;
}

// Only fixed diagnostic codes and a loopback port can leave this observer.
// Never return raw startup output: Kimi can print a bearer token or token URL.
export function observeStartup(config: BridgeConfig, args: string[], spawnImpl: StartupSpawn = spawn) {
  const codes = new Set<string>();
  let failureError: BridgeToolError | undefined;
  let rejectFailure!: (error: BridgeToolError) => void;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  void failure.catch(() => {});
  let resolveAddress!: (url: string) => void;
  const address = new Promise<string>((resolve) => { resolveAddress = resolve; });
  let observing = true;
  const tails = ['', ''];
  const scan = (index: number, chunk: Buffer) => {
    if (!observing) return; // Continue draining pipes without retaining output after startup.
    // Scan bounded windows, including chunk boundaries; do not accumulate log output.
    for (let offset = 0; offset < chunk.length; offset += 1024) {
      const text = tails[index] + chunk.subarray(offset, offset + 1024).toString('utf8');
      for (const code of text.match(/\b(?:EACCES|EADDRINUSE|ENOENT|EPERM|10013)\b/g) ?? []) codes.add(code);
      const match = text.match(/http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(?=[/\s#:])/);
      if (match && Number(match[1]) <= 65535) resolveAddress(`http://127.0.0.1:${Number(match[1])}`);
      tails[index] = text.slice(-128);
    }
  };
  const fail = (exitCode: number | null, signal: string | null, errorCode?: string) => {
    if (!observing || failureError) return;
    if (errorCode && /^(ENOENT|EACCES|EPERM)$/.test(errorCode)) codes.add(errorCode);
    failureError = new BridgeToolError('KIMI_STARTUP_FAILED', 'Kimi server exited or failed to spawn before readiness.', {
      stage: 'preflight', submissionState: 'not_submitted', exitCode, signal,
      serverUrl: config.serverUrl, diagnosticCodes: [...codes],
      ...(process.platform === 'win32' && new URL(config.serverUrl).port !== '0' ? {
        diagnosticCommands: [
          `Get-NetTCPConnection -LocalPort ${Number(new URL(config.serverUrl).port)}`,
          'netsh int ipv4 show excludedportrange protocol=tcp',
          'netsh int ipv6 show excludedportrange protocol=tcp',
          'netsh int ipv4 show dynamicport tcp',
        ],
      } : {}),
      nextActions: ['Check the Kimi executable and startup configuration.',
        'For EACCES/10013 or EADDRINUSE, inspect all TCP states and Windows excluded port ranges; no LISTEN entry does not prove a port is available.',
        'Use KIMI_SERVER_URL=auto with kimi web to let the OS allocate a port.'],
    });
    rejectFailure(failureError);
  };
  let child: ChildProcess;
  try {
    child = spawnImpl(config.kimiCommand, args, {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, KIMI_CODE_HOME: config.kimiCodeHome ?? join(homedir(), '.kimi-code') },
    });
  } catch (error) {
    fail(null, null, (error as NodeJS.ErrnoException).code);
    throw failureError;
  }
  child.stdout?.on('data', (chunk: Buffer) => scan(0, chunk));
  child.stderr?.on('data', (chunk: Buffer) => scan(1, chunk));
  // Keep an error listener after detachment to avoid an unhandled late error event.
  child.on('error', (error: NodeJS.ErrnoException) => fail(null, null, error.code));
  child.on('exit', (code, signal) => fail(code, signal));
  return {
    address, failure,
    assertRunning() { if (failureError) throw failureError; },
    async stop(): Promise<boolean> {
      if (child.exitCode != null || child.signalCode != null) return true;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { child.off('exit', exited); resolve(false); }, 1000);
        const exited = () => { clearTimeout(timer); resolve(true); };
        child.once('exit', exited);
        if (!child.kill()) { clearTimeout(timer); child.off('exit', exited); resolve(false); }
      });
    },
    detach() {
      observing = false;
      tails.fill('');
      child.unref();
      // Draining unreferenced pipes keeps post-startup output out of MCP stdio.
      for (const stream of [child.stdout, child.stderr]) (stream as typeof stream & { unref?: () => void })?.unref?.();
    },
  };
}
