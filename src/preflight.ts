import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveServerToken, type BridgeConfig, type TokenSource } from './config.js';
import { BridgeToolError, KimiApiError, KimiNetworkError } from './errors.js';
import type { KimiHttpClient } from './kimi/http.js';
import { observeStartup, startupArgs, type StartupSpawn } from './startup.js';
import { ServerDiscovery } from './server-discovery.js';

export interface BridgeStatus {
  serverUrl: string;
  webBaseUrl: string;
  canOpenWeb: boolean;
  healthzOk: boolean;
  authOk: boolean;
  status: 'ready' | 'server_unreachable' | 'auth_failed';
  tokenSource: TokenSource;
  autoStart: boolean;
  kimiCommand: string;
  preflightCacheMs: number;
  cacheFresh?: boolean;
  cacheAgeMs?: number;
  cachedUntil?: number;
  diagnostics: string[];
  nextActions: string[];
  commands?: string[];
  serverVersion?: string;
  backend?: string;
}

export interface PreflightOptions {
  spawn?: StartupSpawn;
  resolveToken?: (config: BridgeConfig) => { token?: string; source: TokenSource };
  now?: () => number;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30000;
const DEFAULT_POLL_INTERVAL_MS = 500;

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_/.-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function defaultResolveToken(config: BridgeConfig): { token?: string; source: TokenSource } {
  return resolveServerToken(config.envServerToken, config.kimiCodeHome, homedir());
}

export class KimiPreflight {
  private readonly spawnImpl?: StartupSpawn;
  private readonly resolveToken: NonNullable<PreflightOptions['resolveToken']>;
  private readonly now: NonNullable<PreflightOptions['now']>;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private lastSuccessStatus?: BridgeStatus;
  private lastSuccessAt?: number;
  private inFlight?: Promise<BridgeStatus>;
  private endpointGeneration = 0;

  constructor(
    private readonly config: BridgeConfig,
    private readonly http: KimiHttpClient,
    options: PreflightOptions = {},
  ) {
    this.spawnImpl = options.spawn;
    this.resolveToken = options.resolveToken ?? defaultResolveToken;
    this.now = options.now ?? Date.now;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async ensureReady(): Promise<BridgeStatus> {
    if (this.inFlight) return this.inFlight;
    const operation = this.ensureReadyOnce();
    this.inFlight = operation;
    try { return await operation; } finally { this.inFlight = undefined; }
  }

  private async ensureReadyOnce(): Promise<BridgeStatus> {
    const cached = this.readCache();
    if (cached) return cached;

    if (this.config.autoServer) {
      const discovery = new ServerDiscovery(this.config);
      const saved = await discovery.read();
      if (saved) this.setServerUrl(saved);
      let status = await this.checkOnce();
      if (status.healthzOk) {
        if (!status.authOk) status = await this.verifyAuthWithRetry();
        this.writeCache(status);
        return status;
      }
      if (!this.config.autoStart) throw new BridgeToolError('KIMI_SERVER_UNREACHABLE', 'No discovered Kimi server is reachable and auto-start is disabled.', { submissionState: 'not_submitted' });
      const release = await discovery.lock(this.startupTimeoutMs);
      try {
        // Another MCP process may have finished startup while this caller waited.
        const latest = await discovery.read();
        if (latest) this.setServerUrl(latest);
        status = await this.checkOnce();
        if (!status.healthzOk) status = await this.startServer();
        else if (!status.authOk) status = await this.verifyAuthWithRetry();
        await discovery.save(this.config.serverUrl);
        this.writeCache(status);
        return status;
      } finally { await release(); }
    }

    let status = await this.checkOnce();

    if (!status.healthzOk) {
      if (!this.config.autoStart) {
        throw new Error(
          `Kimi server is not reachable at ${this.config.serverUrl} and KIMI_AUTO_START is disabled. ` +
            `Start the server manually or set KIMI_AUTO_START=true.`,
        );
      }
      status = await this.startServer();
    }

    if (!status.authOk) {
      status = await this.verifyAuthWithRetry();
    }

    if (status.healthzOk && status.authOk) {
      this.writeCache(status);
    }

    return status;
  }

  async getStatus(): Promise<BridgeStatus> {
    const generation = this.endpointGeneration;
    // A live diagnostic must not redirect an in-progress startup back to a stale file.
    if (this.config.autoServer && !this.inFlight) {
      const saved = await new ServerDiscovery(this.config).read();
      if (saved && !this.inFlight && generation === this.endpointGeneration) this.setServerUrl(saved);
    }
    return this.checkOnce();
  }

  private setServerUrl(url: string): void {
    if (this.config.serverUrl !== url) {
      this.endpointGeneration++;
      this.lastSuccessStatus = undefined;
      this.lastSuccessAt = undefined;
    }
    this.config.serverUrl = url;
    this.http.setServerUrl(url);
  }

  private readCache(): BridgeStatus | undefined {
    if (this.config.preflightCacheMs <= 0 || !this.lastSuccessStatus || this.lastSuccessAt == null) {
      return undefined;
    }
    const now = this.now();
    const age = now - this.lastSuccessAt;
    if (age > this.config.preflightCacheMs) {
      return undefined;
    }
    return {
      ...this.lastSuccessStatus,
      cacheFresh: true,
      cacheAgeMs: age,
      cachedUntil: this.lastSuccessAt + this.config.preflightCacheMs,
    };
  }

  private writeCache(status: BridgeStatus): void {
    if (this.config.preflightCacheMs <= 0) return;
    this.lastSuccessStatus = status;
    this.lastSuccessAt = this.now();
  }

  private async checkOnce(): Promise<BridgeStatus> {
    const diagnostics: string[] = [];
    if (this.config.autoServer && new URL(this.config.serverUrl).port === '0') {
      return this.buildStatus(false, false, ['No authenticated automatic endpoint has been discovered yet.']);
    }

    let healthzOk = false;
    try {
      await this.http.get('/healthz');
      healthzOk = true;
    } catch (error) {
      diagnostics.push(`healthz failed: ${this.formatError(error)}`);
    }

    let authOk = false;
    if (healthzOk) {
      authOk = await this.checkAuth();
      if (!authOk) diagnostics.push('auth check failed: /config returned an authentication error');
    }

    return this.buildStatus(healthzOk, authOk, diagnostics);
  }

  private buildStatus(healthzOk: boolean, authOk: boolean, diagnostics: string[]): BridgeStatus {
    const status = healthzOk ? (authOk ? 'ready' : 'auth_failed') : 'server_unreachable';
    const webBaseUrl = `${this.config.serverUrl}/`;
    return {
      serverUrl: this.config.serverUrl,
      webBaseUrl,
      canOpenWeb: healthzOk,
      healthzOk,
      authOk,
      status,
      tokenSource: this.config.serverTokenSource,
      autoStart: this.config.autoStart,
      kimiCommand: this.config.kimiCommand,
      preflightCacheMs: this.config.preflightCacheMs,
      cacheFresh: false,
      diagnostics,
      nextActions: this.buildNextActions(status),
      commands: this.buildCommands(status),
    };
  }

  private startupCommand(manual = false): string {
    const args = this.config.autoServer ? ['web', '--no-open', '--port', '0', '--host', '127.0.0.1'] : this.config.kimiServerArgs ??
      (manual ? ['server', 'start'] : ['server', 'run', '--keep-alive']);
    if (process.platform !== 'win32') {
      return [this.config.kimiCommand, ...args].map(shellQuote).join(' ');
    }
    const parts = [this.config.kimiCommand, ...args].map((arg) =>
      /^[A-Za-z0-9_/.-]+$/.test(arg) ? arg : "'" + arg.replace(/'/g, "''") + "'",
    );
    return (parts[0].startsWith("'") ? '& ' : '') + parts.join(' ');
  }

  private buildNextActions(status: BridgeStatus['status']): string[] {
    if (status === 'ready') {
      return [
        '可以继续委托任务给 Kimi。',
        '可在浏览器中打开 webBaseUrl，或在任务返回的 webUrl 中查看 session。',
      ];
    }
    if (status === 'server_unreachable') {
      if (this.config.autoStart) {
        return [
          '下一次任务调用会自动尝试启动 Kimi server。',
          `也可以手动运行：${this.startupCommand()}`,
        ];
      }
      return [
        `请手动启动 Kimi server，例如：${this.startupCommand(true)}`,
        '或设置 KIMI_AUTO_START=true 让 bridge 在需要时自动启动。',
      ];
    }
    return [
      '请检查 KIMI_SERVER_TOKEN 是否有效，以及 bridge 与 Kimi server 使用的 KIMI_CODE_HOME 是否一致。',
      '本地 smoke 测试可临时使用 --dangerous-bypass-auth 启动 Kimi server。',
    ];
  }

  private buildCommands(status: BridgeStatus['status']): string[] {
    if (status === 'ready') {
      return [];
    }

    const commands: string[] = [];

    if (status === 'server_unreachable') {
      if (this.config.autoStart) {
        commands.push(this.startupCommand());
      } else {
        commands.push(this.startupCommand(true));
      }
    }

    if (status === 'auth_failed') {
      commands.push(...this.buildTokenCheckCommands());
    }

    // If the bridge code or plugin config was just changed, rebuilding and reinstalling
    // the local plugin is a safe next step before trying again.
    commands.push('pnpm build');
    commands.push('codex plugin add kimi-delegate@codex-kimi-bridge-local');

    return commands;
  }

  private buildTokenCheckCommands(): string[] {
    const { serverTokenSource, kimiCodeHome } = this.config;

    if (serverTokenSource === 'env') {
      return [
        'echo "KIMI_SERVER_TOKEN is configured via environment; verify it is valid and matches the server."',
      ];
    }

    const check = (path: string) =>
      `test -f ${shellQuote(path)} && echo "token file exists" || echo "token file missing"`;

    if (serverTokenSource === 'kimi_code_home' && kimiCodeHome) {
      return [check(join(kimiCodeHome, 'server.token'))];
    }

    if (serverTokenSource === 'home') {
      return [check(join(homedir(), '.kimi-code', 'server.token'))];
    }

    // No token source known; suggest checking the default file and any custom home.
    const commands = [check(join(homedir(), '.kimi-code', 'server.token'))];
    if (kimiCodeHome) {
      commands.push(check(join(kimiCodeHome, 'server.token')));
    }
    return commands;
  }

  private async checkAuth(): Promise<boolean> {
    try {
      await this.http.get('/config');
      return true;
    } catch {
      return false;
    }
  }

  private async startServer(): Promise<BridgeStatus> {
    const observer = observeStartup(this.config, startupArgs(this.config), this.spawnImpl);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BridgeToolError('KIMI_STARTUP_TIMEOUT',
        `Kimi server did not respond to healthz/auth within ${this.startupTimeoutMs}ms.`,
        { stage: 'preflight', submissionState: 'not_submitted', serverUrl: this.config.serverUrl,
          startupMayStillBeRunning: true })), this.startupTimeoutMs);
    });
    const ready = async () => {
      if (this.config.autoServer) {
        const url = await observer.address;
        if (stopped) throw new Error('Startup observation ended.');
        this.setServerUrl(url);
      }
      const status = await this.waitForHealthz(() => stopped);
      if (stopped) throw new Error('Startup observation ended.');
      const authenticated = status.authOk ? status : await this.verifyAuthWithRetry();
      observer.assertRunning();
      return authenticated;
    };
    try {
      return await Promise.race([ready(), observer.failure, timeout]);
    } catch (error) {
      stopped = true;
      const terminated = await observer.stop();
      if (error instanceof BridgeToolError) {
        throw new BridgeToolError(error.code, error.message, { ...(error.details as object), startupMayStillBeRunning: !terminated });
      }
      throw error;
    } finally {
      stopped = true;
      clearTimeout(timer);
      observer.detach();
    }
  }

  private async waitForHealthz(stopped: () => boolean): Promise<BridgeStatus> {
    while (!stopped()) {
      const lastStatus = await this.checkOnce();
      if (lastStatus.healthzOk) {
        return lastStatus;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }

    throw new Error('Startup observation ended.');
  }

  private async verifyAuthWithRetry(): Promise<BridgeStatus> {
    let authOk = await this.checkAuth();
    if (authOk) return this.buildStatus(true, true, []);

    const refreshed = this.resolveToken(this.config);
    if (refreshed.token && refreshed.token !== this.config.serverToken) {
      this.http.setServerToken(refreshed.token);
      this.config.serverToken = refreshed.token;
      this.config.serverTokenSource = refreshed.source;
      authOk = await this.checkAuth();
      if (authOk) return this.buildStatus(true, true, []);
    }

    throw new BridgeToolError('KIMI_AUTH_FAILED',
      `Kimi server authentication failed. The token may be invalid, or the server is using a different KIMI_CODE_HOME. ` +
        `For local smoke testing only, start Kimi with --dangerous-bypass-auth.`,
      { stage: 'preflight', submissionState: 'not_submitted' },
    );
  }

  private formatError(error: unknown): string {
    if (error instanceof KimiApiError) {
      return `KimiApiError ${error.code}: ${error.message}`;
    }
    if (error instanceof KimiNetworkError) {
      return `KimiNetworkError: ${error.message}`;
    }
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    return String(error);
  }
}
