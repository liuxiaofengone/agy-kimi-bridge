import { KimiApiError } from '../errors.js';
import type { KimiHttpClient } from './http.js';
import { normalizeRuntimeStatus, type BridgeRuntimeStatus } from './runtime-status.js';
import type { KimiServerConfig, KimiServerMeta, ListSessionsInput, ListSessionsResult, PendingApproval, PendingQuestion, PermissionMode, PromptQueueSnapshot, PromptSubmitResult, RuntimeSession, SessionStatus, WireSession } from './types.js';

export interface HttpPort {
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
}

export interface CreateSessionInput {
  cwd: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface SubmitPromptInput {
  content: string;
  model: string;
  thinking: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  swarmMode?: boolean;
}

export interface WireMessage {
  id: string;
  role: string;
  content: Array<{ type: string; text?: string }>;
}

export interface GitStatusResult {
  entries: Record<string, string>;
  additions: number;
  deletions: number;
}

export interface WireTurnItem {
  type: string;
  text?: string;
}

export interface WireTurn {
  items?: WireTurnItem[];
}

export interface WireInteraction {
  interaction_id: string;
  kind: 'approval' | 'question' | string;
  request?: Record<string, unknown>;
  [key: string]: unknown;
}

function messageText(message: WireMessage): string {
  return message.content.map((part) => part.text ?? '').join('');
}

function extractMessagesFromTurns(turns: readonly WireTurn[]): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  for (const turn of turns) {
    for (const item of turn.items ?? []) {
      if (item.type === 'user_message') {
        messages.push({ role: 'user', content: item.text ?? '' });
      } else if (item.type === 'assistant_message') {
        messages.push({ role: 'assistant', content: item.text ?? '' });
      }
    }
  }
  return messages.reverse();
}

function isMissingRouteError(error: unknown): boolean {
  return error instanceof KimiApiError && error.httpStatus === 404 && error.code === 404;
}

function isUnsupportedAbortActionError(error: unknown): boolean {
  return (
    isMissingRouteError(error) ||
    (error instanceof KimiApiError && error.code === 40001 && /unsupported action/i.test(error.message))
  );
}

const MAX_SESSION_LIST_PAGE_SIZE = 100;
const DEFAULT_TURNS_PAGE_SIZE = 200;

function resolveSessionCwd(session: WireSession): string {
  const candidates = [
    session.metadata?.cwd,
    session.environment_cwd,
    session.cwd,
    session.workspace_root,
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return '';
}

function normalizeSession(session: WireSession): RuntimeSession {
  const { status: _wireStatus, metadata, ...rest } = session;
  return {
    ...rest,
    metadata: {
      ...(metadata ?? {}),
      cwd: resolveSessionCwd(session),
    },
    status: normalizeRuntimeStatus(session),
  };
}

export class KimiClient {
  constructor(private readonly http: KimiHttpClient | HttpPort) {}

  async createSession(input: CreateSessionInput): Promise<RuntimeSession> {
    const session = await this.http.post<WireSession>('/sessions', {
      ...(input.title ? { title: input.title } : {}),
      metadata: {
        ...input.metadata,
        cwd: input.cwd,
      },
    });
    return normalizeSession(session);
  }

  getStatus(sessionId: string): Promise<SessionStatus> {
    return this.http.get(`/sessions/${encodeURIComponent(sessionId)}/status`);
  }

  async getSession(sessionId: string): Promise<RuntimeSession> {
    const session = await this.http.get<WireSession>(`/sessions/${encodeURIComponent(sessionId)}`);
    return normalizeSession(session);
  }

  async getRuntimeStatus(sessionId: string): Promise<BridgeRuntimeStatus> {
    return (await this.getSession(sessionId)).status;
  }

  getMeta(): Promise<KimiServerMeta> {
    return this.http.get('/meta');
  }

  submitPrompt(sessionId: string, input: SubmitPromptInput): Promise<PromptSubmitResult> {
    return this.http.post(`/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      content: [{ type: 'text', text: input.content }],
      model: input.model,
      thinking: input.thinking,
      permission_mode: input.permissionMode,
      plan_mode: input.planMode,
      ...(input.swarmMode === undefined ? {} : { swarm_mode: input.swarmMode }),
    });
  }

  async listMessages(sessionId: string): Promise<Array<{ role: string; content: string }>> {
    try {
      const page = await this.http.get<{ items: WireMessage[] }>(`/sessions/${encodeURIComponent(sessionId)}/messages`);
      return page.items.map((message) => ({ role: message.role, content: messageText(message) }));
    } catch (error) {
      if (!isMissingRouteError(error)) throw error;
      const page = await this.http.get<{ turns: WireTurn[] }>(
        `/sessions/${encodeURIComponent(sessionId)}/agents/main/turns`,
        { page_size: DEFAULT_TURNS_PAGE_SIZE },
      );
      return extractMessagesFromTurns(page.turns ?? []);
    }
  }

  getGitStatus(sessionId: string): Promise<GitStatusResult> {
    return this.http.post(`/sessions/${encodeURIComponent(sessionId)}/fs:git_status`, {});
  }

  getFileDiff(sessionId: string, path: string): Promise<{ path: string; diff: string }> {
    return this.http.post(`/sessions/${encodeURIComponent(sessionId)}/fs:diff`, { path });
  }

  async abortSession(sessionId: string): Promise<{ aborted: boolean }> {
    try {
      return await this.http.post<{ aborted: boolean }>(`/sessions/${encodeURIComponent(sessionId)}:abort`);
    } catch (error) {
      if (!isUnsupportedAbortActionError(error)) throw error;
      const result = await this.http.post<{ cancelled?: boolean; aborted?: boolean }>(
        `/sessions/${encodeURIComponent(sessionId)}:cancel`,
        {},
      );
      return { aborted: Boolean(result.cancelled ?? result.aborted) };
    }
  }

  listPrompts(sessionId: string): Promise<PromptQueueSnapshot> {
    return this.http.get(`/sessions/${encodeURIComponent(sessionId)}/prompts`);
  }

  abortPrompt(sessionId: string, promptId: string): Promise<{ aborted: boolean }> {
    return this.http.post(
      `/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:abort`,
    );
  }

  getConfig(): Promise<KimiServerConfig> {
    return this.http.get('/config');
  }

  async resolveDefaultModel(): Promise<string | undefined> {
    const config = await this.getConfig();
    const model = config.default_model;
    return model && model.trim().length > 0 ? model : undefined;
  }

  async listPendingApprovals(sessionId: string): Promise<PendingApproval[]> {
    try {
      const page = await this.http.get<{ items: PendingApproval[] }>(
        `/sessions/${encodeURIComponent(sessionId)}/approvals`,
        { status: 'pending' },
      );
      return page.items;
    } catch (error) {
      if (!isMissingRouteError(error)) throw error;
      const page = await this.http.get<{ items: WireInteraction[] }>(
        `/sessions/${encodeURIComponent(sessionId)}/interactions`,
      );
      return (page.items ?? [])
        .filter((item) => item.kind === 'approval')
        .map((item) => ({
          ...item,
          ...(item.request ?? {}),
          approval_id: item.interaction_id,
        }));
    }
  }

  async listPendingQuestions(sessionId: string): Promise<PendingQuestion[]> {
    try {
      const page = await this.http.get<{ items: PendingQuestion[] }>(
        `/sessions/${encodeURIComponent(sessionId)}/questions`,
        { status: 'pending' },
      );
      return page.items;
    } catch (error) {
      if (!isMissingRouteError(error)) throw error;
      const page = await this.http.get<{ items: WireInteraction[] }>(
        `/sessions/${encodeURIComponent(sessionId)}/interactions`,
      );
      return (page.items ?? [])
        .filter((item) => item.kind === 'question')
        .map((item) => ({
          ...item,
          ...(item.request ?? {}),
          question_id: item.interaction_id,
        }));
    }
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    const requestedPageSize = input.pageSize ?? 20;
    const page = await this.http.get<{ items: WireSession[] }>('/sessions', {
      page_size: input.status === undefined ? requestedPageSize : MAX_SESSION_LIST_PAGE_SIZE,
      include_archive: input.includeArchive,
      exclude_empty: input.excludeEmpty,
    });
    const normalized = page.items.map(normalizeSession);
    const filtered = input.status === undefined
      ? normalized
      : normalized.filter((session) => session.status === input.status);
    return { items: filtered.slice(0, requestedPageSize) };
  }
}
