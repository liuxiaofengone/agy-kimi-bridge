import { describe, expect, it, vi } from 'vitest';
import { KimiApiError } from '../src/errors.js';
import { KimiClient, type HttpPort } from '../src/kimi/client.js';
import { selectLatestMeaningfulMessage } from '../src/messages.js';

describe('KimiClient', () => {
  it('creates a session with cwd metadata', async () => {
    const http: HttpPort = {
      post: vi.fn(async () => ({ id: 's1', status: 'idle', metadata: { cwd: '/repo' }, title: 'Task', agent_config: {}, last_seq: 0 })) as HttpPort['post'],
      get: vi.fn(),
    };
    const client = new KimiClient(http);
    await expect(client.createSession({ cwd: '/repo', title: 'Task' })).resolves.toMatchObject({ id: 's1' });
    expect(http.post).toHaveBeenCalledWith('/sessions', { title: 'Task', metadata: { cwd: '/repo' } });
  });

  it('merges caller metadata and preserves cwd', async () => {
    const http: HttpPort = {
      post: vi.fn(async () => ({ id: 's1', status: 'idle', metadata: { cwd: '/repo' }, title: 'task', agent_config: {}, last_seq: 0 })) as HttpPort['post'],
      get: vi.fn(),
    };
    const client = new KimiClient(http);
    await client.createSession({
      cwd: '/repo',
      title: 'task',
      metadata: { codex_kimi_bridge: { schema_version: 1, base_commit: 'a'.repeat(40) } },
    });

    expect(http.post).toHaveBeenCalledWith('/sessions', {
      title: 'task',
      metadata: {
        codex_kimi_bridge: { schema_version: 1, base_commit: 'a'.repeat(40) },
        cwd: '/repo',
      },
    });
  });

  it('submits prompts with required runtime fields', async () => {
    const http: HttpPort = {
      post: vi.fn(async () => ({ prompt_id: 'p1', user_message_id: 'm1', status: 'running' })) as HttpPort['post'],
      get: vi.fn(),
    };
    const client = new KimiClient(http);
    await client.submitPrompt('s1', {
      content: 'hello',
      model: 'kimi-k2',
      thinking: 'high',
      permissionMode: 'auto',
      planMode: false,
      swarmMode: true,
    });
    expect(http.post).toHaveBeenCalledWith('/sessions/s1/prompts', {
      content: [{ type: 'text', text: 'hello' }],
      model: 'kimi-k2',
      thinking: 'high',
      permission_mode: 'auto',
      plan_mode: false,
      swarm_mode: true,
    });
  });

  it('aborts a session with the real Kimi action suffix route', async () => {
    const http: HttpPort = {
      post: vi.fn(async () => ({ aborted: true })) as HttpPort['post'],
      get: vi.fn(),
    };
    const client = new KimiClient(http);
    await expect(client.abortSession('s1')).resolves.toEqual({ aborted: true });
    expect(http.post).toHaveBeenCalledWith('/sessions/s1:abort');
  });

  it('reads the active and queued prompt snapshot', async () => {
    const queue = {
      active: {
        prompt_id: 'p1',
        user_message_id: 'm1',
        status: 'running' as const,
        content: [{ type: 'text', text: 'first' }],
        created_at: '2026-11-05T00:00:00Z',
      },
      queued: [{
        prompt_id: 'p2',
        user_message_id: 'm2',
        status: 'queued' as const,
        content: [{ type: 'text', text: 'second' }],
        created_at: '2026-11-05T00:00:01Z',
      }],
    };
    const http: HttpPort = {
      post: vi.fn(),
      get: vi.fn(async () => queue) as HttpPort['get'],
    };
    const client = new KimiClient(http);

    await expect(client.listPrompts('s/1')).resolves.toEqual(queue);
    expect(http.get).toHaveBeenCalledWith('/sessions/s%2F1/prompts');
  });

  it('aborts a running prompt by id', async () => {
    const http: HttpPort = {
      post: vi.fn(async () => ({ aborted: true })) as HttpPort['post'],
      get: vi.fn(),
    };
    const client = new KimiClient(http);

    await expect(client.abortPrompt('s/1', 'p/1')).resolves.toEqual({ aborted: true });
    expect(http.post).toHaveBeenCalledWith('/sessions/s%2F1/prompts/p%2F1:abort');
  });

  it('lists pending approvals and questions', async () => {
    const http: HttpPort = {
      post: vi.fn(),
      get: vi.fn(async (path: string) => {
        if (path.includes('/approvals')) return { items: [{ approval_id: 'a1', tool_name: 'Bash' }] };
        if (path.includes('/questions')) return { items: [{ question_id: 'q1', questions: [] }] };
        return {};
      }) as HttpPort['get'],
    };
    const client = new KimiClient(http);

    await expect(client.listPendingApprovals('s1')).resolves.toEqual([{ approval_id: 'a1', tool_name: 'Bash' }]);
    await expect(client.listPendingQuestions('s1')).resolves.toEqual([{ question_id: 'q1', questions: [] }]);

    expect(http.get).toHaveBeenCalledWith('/sessions/s1/approvals', { status: 'pending' });
    expect(http.get).toHaveBeenCalledWith('/sessions/s1/questions', { status: 'pending' });
  });

  it('fetches a session by id', async () => {
    const http: HttpPort = {
      post: vi.fn(),
      get: vi.fn(async () => ({ id: 's1', status: 'idle', metadata: { cwd: '/repo' }, title: 'Task', agent_config: {}, last_seq: 0 })) as HttpPort['get'],
    };
    const client = new KimiClient(http);

    await expect(client.getSession('s1')).resolves.toMatchObject({ id: 's1', metadata: { cwd: '/repo' } });
    expect(http.get).toHaveBeenCalledWith('/sessions/s1');
  });

  it('normalizes legacy and Kimi 0.27 session resources', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === '/sessions/legacy') {
        return { id: 'legacy', title: 'old', status: 'running', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 };
      }
      return {
        id: 'modern',
        title: 'new',
        busy: false,
        pending_interaction: 'question',
        metadata: { cwd: '/repo' },
        agent_config: { model: '' },
        last_seq: 0,
      };
    }) as HttpPort['get'];
    const client = new KimiClient({ get, post: vi.fn() as HttpPort['post'] });

    await expect(client.getRuntimeStatus('legacy')).resolves.toBe('running');
    await expect(client.getRuntimeStatus('modern')).resolves.toBe('awaiting_question');
  });

  it('filters normalized session statuses client-side for Kimi 0.27', async () => {
    const get = vi.fn(async () => ({
      items: [
        { id: 's1', title: 'running', busy: true, pending_interaction: 'none', metadata: { cwd: '/repo' }, agent_config: { model: '' }, last_seq: 0 },
        { id: 's2', title: 'failed', busy: false, pending_interaction: 'none', last_turn_reason: 'failed', metadata: { cwd: '/repo' }, agent_config: { model: '' }, last_seq: 0 },
        { id: 's3', title: 'idle', status: 'idle', metadata: { cwd: '/repo' }, agent_config: {}, last_seq: 0 },
      ],
    })) as HttpPort['get'];
    const client = new KimiClient({ get, post: vi.fn() as HttpPort['post'] });

    const result = await client.listSessions({ pageSize: 1, status: 'failed' });

    expect(get).toHaveBeenCalledWith('/sessions', {
      page_size: 100,
      include_archive: undefined,
      exclude_empty: undefined,
    });
    expect(result.items.map((session) => [session.id, session.status])).toEqual([['s2', 'failed']]);
  });

  it('preserves the requested page size when no status filter is used', async () => {
    const get = vi.fn(async () => ({ items: [] })) as HttpPort['get'];
    const client = new KimiClient({ get, post: vi.fn() as HttpPort['post'] });

    await client.listSessions({ pageSize: 5, includeArchive: true, excludeEmpty: true });

    expect(get).toHaveBeenCalledWith('/sessions', {
      page_size: 5,
      include_archive: true,
      exclude_empty: true,
    });
  });

  it('reads safe Kimi server metadata', async () => {
    const get = vi.fn(async () => ({ server_version: '0.27.0', backend: 'v2' })) as HttpPort['get'];
    const client = new KimiClient({ get, post: vi.fn() as HttpPort['post'] });

    await expect(client.getMeta()).resolves.toEqual({ server_version: '0.27.0', backend: 'v2' });
    expect(get).toHaveBeenCalledWith('/meta');
  });

  it('normalizes Kimi 2.8.0 activity sessions and populates metadata.cwd from top-level fields', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === '/sessions/s-idle') {
        return {
          id: 's-idle',
          title: 'Kimi 2.8 session',
          activity: 'idle',
          pending_interaction: 'none',
          last_turn_outcome: 'interrupted',
          cwd: '/repo/from-cwd',
          workspace_root: '/repo/root',
          metadata: {},
        };
      }
      return {
        id: 's-env',
        title: 'Kimi 2.8 env session',
        activity: 'turn',
        pending_interaction: 'none',
        cwd: '/repo/from-cwd',
        environment_cwd: '/repo/packages/app',
        workspace_root: '/repo',
      };
    }) as HttpPort['get'];
    const client = new KimiClient({ get, post: vi.fn() as HttpPort['post'] });

    await expect(client.getSession('s-idle')).resolves.toMatchObject({
      id: 's-idle',
      status: 'aborted',
      metadata: { cwd: '/repo/from-cwd' },
    });
    await expect(client.getSession('s-env')).resolves.toMatchObject({
      id: 's-env',
      status: 'running',
      metadata: { cwd: '/repo/packages/app' },
    });
  });

  it('falls back to /agents/main/turns when /messages returns HTTP 404', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === '/sessions/s1/messages') {
        throw new KimiApiError(404, 'HTTP error 404 Not Found', undefined, undefined, 404);
      }
      if (path === '/sessions/s1/agents/main/turns') {
        return {
          turns: [
            {
              items: [
                { type: 'user_message', text: 'Push code' },
                { type: 'reasoning', text: 'internal thought' },
                { type: 'tool_call', name: 'Bash' },
                { type: 'assistant_message', text: 'Pushed to origin/main.' },
              ],
            },
          ],
          has_more: false,
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    }) as HttpPort['get'];
    const client = new KimiClient({ get, post: vi.fn() as HttpPort['post'] });

    await expect(client.listMessages('s1')).resolves.toEqual([
      { role: 'assistant', content: 'Pushed to origin/main.' },
      { role: 'user', content: 'Push code' },
    ]);
    expect(get).toHaveBeenCalledWith('/sessions/s1/agents/main/turns', { page_size: 200 });
  });

  it('returns newest-first messages across multiple turns with intermediate assistant messages', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === '/sessions/s1/messages') {
        throw new KimiApiError(404, 'HTTP error 404 Not Found', undefined, undefined, 404);
      }
      if (path === '/sessions/s1/agents/main/turns') {
        return {
          turns: [
            {
              items: [
                { type: 'user_message', text: 'Fix the bug' },
                { type: 'reasoning', text: 'thinking about the bug' },
                { type: 'assistant_message', text: 'Let me look at the code.' },
                { type: 'tool_call', name: 'Read' },
                { type: 'assistant_message', text: 'First fix is in.' },
              ],
            },
            {
              items: [
                { type: 'user_message', text: 'Now add tests' },
                { type: 'assistant_message', text: 'Drafting tests.' },
                { type: 'tool_call', name: 'Edit' },
                { type: 'assistant_message', text: 'Tests added and passing.' },
              ],
            },
          ],
          has_more: false,
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    }) as HttpPort['get'];
    const client = new KimiClient({ get, post: vi.fn() as HttpPort['post'] });

    const messages = await client.listMessages('s1');
    expect(messages).toEqual([
      { role: 'assistant', content: 'Tests added and passing.' },
      { role: 'assistant', content: 'Drafting tests.' },
      { role: 'user', content: 'Now add tests' },
      { role: 'assistant', content: 'First fix is in.' },
      { role: 'assistant', content: 'Let me look at the code.' },
      { role: 'user', content: 'Fix the bug' },
    ]);
    expect(selectLatestMeaningfulMessage(messages, 'assistant')).toBe('Tests added and passing.');
    expect(selectLatestMeaningfulMessage(messages, 'user')).toBe('Now add tests');
  });

  it('propagates 40401 session-not-found errors from listMessages without falling back', async () => {
    const get = vi.fn(async () => {
      throw new KimiApiError(40401, 'session not found', 'req-1', undefined, 404);
    }) as HttpPort['get'];
    const client = new KimiClient({ get, post: vi.fn() as HttpPort['post'] });

    await expect(client.listMessages('missing')).rejects.toMatchObject({ code: 40401 });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('falls back to :cancel when :abort returns unsupported action on Kimi 2.8.0', async () => {
    const post = vi.fn(async (path: string) => {
      if (path === '/sessions/s1:abort') {
        throw new KimiApiError(40001, 'session_id: unsupported action: s1:abort', 'req-1', undefined, 200);
      }
      if (path === '/sessions/s1:cancel') {
        return { cancelled: true };
      }
      throw new Error(`Unexpected path: ${path}`);
    }) as HttpPort['post'];
    const client = new KimiClient({ get: vi.fn() as HttpPort['get'], post });

    await expect(client.abortSession('s1')).resolves.toEqual({ aborted: true });
    expect(post).toHaveBeenCalledWith('/sessions/s1:cancel', {});
  });

  it('falls back to /interactions when /approvals or /questions returns HTTP 404', async () => {
    const get = vi.fn(async (path: string) => {
      if (path === '/sessions/s1/approvals' || path === '/sessions/s1/questions') {
        throw new KimiApiError(404, 'HTTP error 404 Not Found', undefined, undefined, 404);
      }
      if (path === '/sessions/s1/interactions') {
        return {
          items: [
            { interaction_id: 'int-a1', kind: 'approval', request: { tool_name: 'Bash', action: 'git push' } },
            { interaction_id: 'int-q1', kind: 'question', request: { questions: [{ id: 'q_0', question: 'Which branch?' }] } },
          ],
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    }) as HttpPort['get'];
    const client = new KimiClient({ get, post: vi.fn() as HttpPort['post'] });

    await expect(client.listPendingApprovals('s1')).resolves.toEqual([
      expect.objectContaining({ approval_id: 'int-a1', interaction_id: 'int-a1', tool_name: 'Bash', action: 'git push' }),
    ]);
    await expect(client.listPendingQuestions('s1')).resolves.toEqual([
      expect.objectContaining({ question_id: 'int-q1', interaction_id: 'int-q1', questions: [{ id: 'q_0', question: 'Which branch?' }] }),
    ]);
  });
});
