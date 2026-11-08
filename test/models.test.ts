import { describe, expect, it, vi } from 'vitest';
import { createToolHandlers, looksRateLimited } from '../src/tools.js';
import { KimiApiError } from '../src/errors.js';
import type { KimiClient } from '../src/kimi/client.js';
import type { BridgeConfig } from '../src/config.js';
import type { KimiPreflight } from '../src/preflight.js';

function makeKimi(overrides: Record<string, unknown> = {}): KimiClient {
  return {
    createSession: vi.fn(async () => ({ id: 's1', title: 't', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
    getSession: vi.fn(async () => ({ id: 's1', title: 't', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
    submitPrompt: vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' })),
    listPrompts: vi.fn(async () => ({ active: null, queued: [] })),
    listMessages: vi.fn(async () => []),
    getRuntimeStatus: vi.fn(async () => 'idle'),
    getGitStatus: vi.fn(async () => ({ entries: {}, additions: 0, deletions: 0 })),
    listPendingApprovals: vi.fn(async () => []),
    listPendingQuestions: vi.fn(async () => []),
    getConfig: vi.fn(async () => ({
      default_model: 'kimi-code/k3',
      models: {
        'kimi-code/k3': { provider: 'managed:kimi-code', displayName: 'K3', maxContextSize: 1048576, supportEfforts: ['low', 'high'], defaultEffort: 'high', has_api_key: false },
        'other/raw': {},
      },
    })),
    ...overrides,
  } as unknown as KimiClient;
}

const config = {
  serverUrl: 'http://127.0.0.1:1', defaultThinking: 'high', defaultPermissionMode: 'auto', requestTimeoutMs: 1000,
  serverTokenSource: 'none', autoStart: false, kimiCommand: 'kimi', preflightCacheMs: 0, stateDir: '/tmp/kimi-models-test',
} as unknown as BridgeConfig;
const preflight = { ensureReady: vi.fn(async () => ({ healthzOk: true, authOk: true })) } as unknown as KimiPreflight;

describe('model selection', () => {
  it('lists configured models with the default flagged and secrets omitted', async () => {
    const handlers = createToolHandlers({ kimi: makeKimi(), config, preflight });
    const result = await handlers.kimi_list_models();
    expect(result.defaultModel).toBe('kimi-code/k3');
    expect(result.models).toEqual([
      { id: 'kimi-code/k3', displayName: 'K3', provider: 'managed:kimi-code', maxContextSize: 1048576, supportEfforts: ['low', 'high'], defaultEffort: 'high', isDefault: true },
      { id: 'other/raw', displayName: 'other/raw', isDefault: false },
    ]);
    expect(JSON.stringify(result)).not.toContain('has_api_key');
  });

  it('maps HTTP 429 on submit to KIMI_RATE_LIMITED with not_submitted', async () => {
    const kimi = makeKimi({ submitPrompt: vi.fn(async () => { throw new KimiApiError(42900, 'busy', 'req-1', undefined, 429); }) });
    const handlers = createToolHandlers({ kimi, config, preflight });
    await expect(handlers.kimi_continue_task({ sessionId: 's1', task: 'x', model: 'kimi-code/k3' })).rejects.toMatchObject({
      code: 'KIMI_RATE_LIMITED',
      details: { sessionId: 's1', model: 'kimi-code/k3', submissionState: 'not_submitted' },
    });
  });

  it('flags rate-limited failed turns in delegate diagnostics', async () => {
    const kimi = makeKimi({
      getSession: vi.fn(async () => ({ id: 's1', title: 't', status: 'failed', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 })),
      getRuntimeStatus: vi.fn(async () => 'failed'),
      listMessages: vi.fn(async () => [{ role: 'assistant', content: 'Error code: 429 - rate limit exceeded' }]),
    });
    const handlers = createToolHandlers({ kimi, config, preflight });
    const result = await handlers.kimi_delegate_and_wait({ cwd: '/repo', task: 'x', acceptanceCriteria: [], plan: [], model: 'kimi-code/k3', timeoutMs: 200 });
    expect(result.wait.status).toBe('failed');
    expect(result.diagnostics?.rateLimited).toBe(true);
    expect(result.diagnostics?.suggestedNextActions.join('\n')).toContain('kimi_list_models');
  });

  it('detects common rate limit wording', () => {
    expect(looksRateLimited('HTTP 429 Too Many Requests')).toBe(true);
    expect(looksRateLimited('请求被限流')).toBe(true);
    expect(looksRateLimited('wrote 1429 lines')).toBe(false);
  });
});
