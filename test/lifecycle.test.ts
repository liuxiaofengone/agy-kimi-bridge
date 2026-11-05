import { describe, expect, it } from 'vitest';
import { KimiApiError } from '../src/errors.js';
import { runToolHandler } from '../src/index.js';
import { KimiClient, type HttpPort } from '../src/kimi/client.js';
import { KimiHttpClient } from '../src/kimi/http.js';
import type { PromptQueueSnapshot } from '../src/kimi/types.js';
import { createToolHandlers } from '../src/tools.js';
import type { BridgeConfig } from '../src/config.js';
import type { KimiPreflight } from '../src/preflight.js';

const emptyQueue: PromptQueueSnapshot = { active: null, queued: [] };
const prompt = (id: string, status: 'running' | 'queued' | 'blocked' = 'running') => ({
  prompt_id: id, user_message_id: `message-${id}`, status, content: [], created_at: '2026-11-05T00:00:00Z',
});

// Exercise the real client and tool handlers; fake only the external HTTP boundary.
function fixture(options: {
  queue?: () => PromptQueueSnapshot;
  status?: string | (() => string);
  legacy?: boolean;
  abortError?: Error;
  onAbort?: () => void;
  http?: HttpPort;
} = {}) {
  const requests: string[] = [];
  const session = () => ({ id: 's1', title: 'Lifecycle test', status: typeof options.status === 'function' ? options.status() : options.status ?? 'idle', metadata: { cwd: '/repo' } });
  const http: HttpPort = {
    async get<T>(url: string): Promise<T> {
      requests.push(`GET ${url}`);
      if (url === '/sessions/s1/prompts') {
        if (options.legacy) throw new KimiApiError(404, 'Not Found');
        return (options.queue?.() ?? emptyQueue) as T;
      }
      if (url === '/sessions/s1') return session() as T;
      if (url === '/sessions') return { items: [session()] } as T;
      if (url.endsWith('/messages')) return { items: [] } as T;
      if (url.endsWith('/approvals')) return { items: [{ approval_id: 'a1' }] } as T;
      if (url.endsWith('/questions')) return { items: [{ question_id: 'q1' }] } as T;
      throw new Error(`Unexpected GET ${url}`);
    },
    async post<T>(url: string): Promise<T> {
      requests.push(`POST ${url}`);
      if (url === '/sessions/s1/fs:git_status') return { entries: {}, additions: 0, deletions: 0 } as T;
      if (url === '/sessions/s1/prompts') return { prompt_id: 'p1', user_message_id: 'm1', status: 'queued' } as T;
      if (url.endsWith(':abort')) {
        if (options.abortError) throw options.abortError;
        options.onAbort?.();
        return { aborted: true } as T;
      }
      throw new Error(`Unexpected POST ${url}`);
    },
  };
  const handlers = createToolHandlers({
    kimi: new KimiClient(options.http ?? http),
    config: { serverUrl: 'http://127.0.0.1:58627', defaultModel: 'test-model', defaultThinking: 'high', defaultPermissionMode: 'auto', requestTimeoutMs: 1000 } as BridgeConfig,
    preflight: { ensureReady: async () => ({}) } as KimiPreflight,
  });
  return { handlers, requests };
}

const delegation = { cwd: '/repo', sessionId: 's1', task: 'Lifecycle test', plan: [], acceptanceCriteria: [], timeoutMs: 0 };

describe('prompt lifecycle safeguards', () => {
  it('does not build a review package while the submitted prompt is queued during transient idle', async () => {
    const { handlers } = fixture({ queue: () => ({ active: null, queued: [prompt('p1', 'queued')] }) });
    const result = await handlers.kimi_delegate_and_wait({ ...delegation, allowQueue: true });
    expect(result.wait.status).toBe('timeout');
    expect(result.reviewPackage).toBeUndefined();
    expect(result.promptWait).toMatchObject({ promptId: 'p1', status: 'timeout', queueEvidence: 'available' });
  });

  it('does not reuse a transient idle session as completed while prompts remain queued', async () => {
    const { handlers } = fixture({ queue: () => ({ active: null, queued: [prompt('p1', 'queued')] }) });
    const result = await handlers.kimi_delegate_and_wait({ ...delegation, dedupe: { titleContains: 'Lifecycle test' } });
    expect(result.dedupe?.reused).toBe(true);
    expect(result.wait.status).toBe('timeout');
    expect(result.reviewPackage).toBeUndefined();
  });

  it('does not report idle while a queued prompt is pending', async () => {
    const { handlers } = fixture({ queue: () => ({ active: null, queued: [prompt('p1', 'queued')] }) });
    expect(await handlers.kimi_wait_until_idle({ sessionId: 's1', timeoutMs: 0 })).toEqual({ status: 'timeout' });
  });

  it('refuses continuation when queue is empty but background work is still running', async () => {
    const { handlers, requests } = fixture({ status: 'running' });
    await expect(handlers.kimi_continue_task({ sessionId: 's1', task: 'follow up' })).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    expect(requests.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('uses session status for a legacy continuation guard', async () => {
    const { handlers, requests } = fixture({ status: 'running', legacy: true });
    await expect(handlers.kimi_continue_task({ sessionId: 's1', task: 'follow up' })).rejects.toMatchObject({ code: 'SESSION_BUSY', details: { queueEvidence: 'unavailable' } });
    expect(requests.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('reports a legacy approval wait as blocked with unavailable queue evidence', async () => {
    const { handlers } = fixture({ status: 'awaiting_approval', legacy: true });
    expect(await handlers.kimi_wait_for_prompt({ sessionId: 's1', promptId: 'p1', timeoutMs: 0 })).toMatchObject({ status: 'blocked', sessionStatus: 'awaiting_approval', queueEvidence: 'unavailable' });
  });

  it('includes pending questions when delegation is blocked on its prompt', async () => {
    const { handlers } = fixture({ status: 'awaiting_question', queue: () => ({ active: prompt('p1', 'blocked'), queued: [] }) });
    const result = await handlers.kimi_delegate_and_wait({ ...delegation, allowQueue: true });
    expect(result.wait).toEqual({ status: 'awaiting_question', questions: [{ question_id: 'q1' }] });
    expect(result.promptWait?.status).toBe('blocked');
    expect(result.reviewPackage).toBeUndefined();
  });

  it('never confirms complete termination on a legacy server', async () => {
    const { handlers } = fixture({ legacy: true });
    expect(await handlers.kimi_abort_and_wait({ sessionId: 's1', timeoutMs: 0 })).toMatchObject({ abortRequested: true, terminationConfirmed: false, queueEvidence: 'unavailable' });
  });

  it('does not replace a failed prompt-specific abort with a session-wide abort', async () => {
    const { handlers, requests } = fixture({ queue: () => ({ active: prompt('p1'), queued: [] }), abortError: new KimiApiError(404, 'Prompt not found') });
    await expect(handlers.kimi_abort_and_wait({ sessionId: 's1', promptId: 'p1', timeoutMs: 0 })).rejects.toMatchObject({ code: 404 });
    expect(requests).not.toContain('POST /sessions/s1:abort');
  });

  it('does not abort an unidentified turn when a prompt ID is supplied to a legacy server', async () => {
    const { handlers, requests } = fixture({ legacy: true });
    await expect(handlers.kimi_abort_and_wait({ sessionId: 's1', promptId: 'p1', timeoutMs: 0 })).rejects.toMatchObject({ code: 'PROMPT_ABORT_UNAVAILABLE' });
    expect(requests.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('confirms termination only after both the queue and runtime settle', async () => {
    let aborted = false;
    const { handlers, requests } = fixture({ queue: () => aborted ? emptyQueue : { active: prompt('p1'), queued: [] }, onAbort: () => { aborted = true; } });
    expect(await handlers.kimi_abort_and_wait({ sessionId: 's1', timeoutMs: 0 })).toMatchObject({ abortRequested: true, terminationConfirmed: true, finalStatus: 'idle', queuedPromptIds: [] });
    expect(requests).toContain('POST /sessions/s1/prompts/p1:abort');
  });

  it('does not abort an unverified new turn when only queued prompts were observed', async () => {
    const { handlers, requests } = fixture({ queue: () => ({ active: null, queued: [prompt('p2', 'queued')] }) });
    expect(await handlers.kimi_abort_and_wait({ sessionId: 's1', timeoutMs: 0 })).toMatchObject({ abortRequested: false, terminationConfirmed: false, finalStatus: 'queued_prompts_remain', queuedPromptIds: ['p2'] });
    expect(requests.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('confirms an already idle session without claiming an abort request', async () => {
    const { handlers, requests } = fixture();
    expect(await handlers.kimi_abort_and_wait({ sessionId: 's1', timeoutMs: 0 })).toMatchObject({ abortRequested: false, terminationConfirmed: true, finalStatus: 'idle' });
    expect(requests.filter((r) => r.startsWith('POST'))).toEqual([]);
  });

  it('exposes a structured busy error through MCP', async () => {
    const { handlers } = fixture({ queue: () => ({ active: prompt('p1'), queued: [] }) });
    const result = await runToolHandler(() => handlers.kimi_continue_task({ sessionId: 's1', task: 'follow up' }));
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'SESSION_BUSY', details: { activePromptId: 'p1' } });
  });

  it('refuses a concurrent delegate/continue submission within the same bridge', async () => {
    const { handlers, requests } = fixture();
    const results = await Promise.allSettled([
      handlers.kimi_continue_task({ sessionId: 's1', task: 'first' }),
      handlers.kimi_delegate_task(delegation),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toMatchObject([{ reason: { code: 'SESSION_BUSY' } }]);
    expect(requests.filter((r) => r === 'POST /sessions/s1/prompts')).toHaveLength(1);
  });

  it.each(['failed', 'aborted'])('preserves observed %s instead of accepting a later turn idle', async (terminal) => {
    let observations = 0;
    const { handlers } = fixture({ status: () => observations++ === 0 ? terminal : 'idle' });
    const result = await handlers.kimi_delegate_and_wait({ ...delegation, allowQueue: true });
    expect(result.wait.status).toBe(terminal);
    expect(result.reviewPackage).toBeUndefined();
  });

  it.each([
    { httpStatus: 405, code: 40001 },
    { httpStatus: 200, code: 40401 },
  ])('degrades missing prompt routes through real HTTP errors ($httpStatus/$code)', async ({ httpStatus, code }) => {
    const fetcher: typeof fetch = async (url) => {
      const missing = String(url).endsWith('/prompts');
      return new Response(JSON.stringify({
        code: missing ? code : 0, msg: missing ? 'Unsupported endpoint' : 'success', request_id: 'req_test',
        data: missing ? {} : { id: 's1', status: 'idle', metadata: { cwd: '/repo' } },
      }), { status: missing ? httpStatus : 200 });
    };
    const { handlers } = fixture({ http: new KimiHttpClient('http://localhost:58627', fetcher) });
    expect(await handlers.kimi_wait_for_prompt({ sessionId: 's1', promptId: 'p1', timeoutMs: 0 })).toMatchObject({ status: 'settled', queueEvidence: 'unavailable' });
  });

  it('does not downgrade a genuinely missing session into missing queue support', async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ code: 40401, msg: 'Session not found', request_id: 'req_test', data: {} }));
    const { handlers } = fixture({ http: new KimiHttpClient('http://localhost:58627', fetcher) });
    await expect(handlers.kimi_continue_task({ sessionId: 's1', task: 'follow up' })).rejects.toMatchObject({ code: 40401 });
  });
});
