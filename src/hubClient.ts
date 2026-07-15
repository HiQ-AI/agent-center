// Hub HTTP client (all outbound, NAT-friendly). register / heartbeat / discover / send / inbox / stream / ack.
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

export interface Capability {
  name: string;
  description?: string;
}

function authHeaders(hasBody = false, contentType = 'application/json'): Record<string, string> {
  const token = config.token;
  if (!token) throw new Error('AGENT_CENTER_TOKEN not set (run `agent-center login`, or set the env var)');
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (hasBody) headers['Content-Type'] = contentType;
  return headers;
}

async function responseError(res: Response): Promise<Error> {
  const text = await res.text();
  let detail = res.statusText;
  if (text) {
    try {
      const data = JSON.parse(text) as { error?: unknown };
      if (typeof data.error === 'string') detail = data.error;
      else if (
        typeof data.error === 'object' &&
        data.error !== null &&
        'message' in data.error &&
        typeof data.error.message === 'string'
      ) detail = data.error.message;
      else if (data.error !== undefined) detail = JSON.stringify(data.error);
    } catch {
      detail = text;
    }
  }
  return new Error(`Hub ${res.status}: ${detail}`);
}

async function call<T>(path: string, init: RequestInit = {}, contentType = 'application/json'): Promise<T> {
  // Only send Content-Type when there's a body — a bodyless POST/DELETE (e.g. heartbeat) with
  // Content-Type: application/json makes strict JSON parsers reject an empty body as a 400.
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10000),
    headers: { ...authHeaders(init.body != null, contentType), ...init.headers },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = data?.error
      ? typeof data.error === 'string'
        ? data.error
        : typeof data.error?.message === 'string'
          ? data.error.message
          : JSON.stringify(data.error)
      : res.statusText;
    throw new Error(`Hub ${res.status}: ${detail}`);
  }
  return data as T;
}

// A host-specific dispatcher can attach a fresh MCP process to an identity that it already
// registered. The Hub still verifies ownership and existence on every protected operation.
let registered = process.env.AGENT_CENTER_ATTACHED === '1' && Boolean(process.env.AGENT_ID);

export function isRegistered(): boolean {
  return registered;
}

function requireRegistration(): void {
  if (!registered) {
    throw new Error('this session is not registered; call agent_center_register first');
  }
}

export async function register(input: {
  name: string;
  description?: string;
  capabilities?: Capability[];
  visibility?: 'owner' | 'org' | 'public';
  discoverable?: boolean;
  acceptsDelegation?: boolean;
}): Promise<unknown> {
  const body = {
    id: config.agentId,
    kind: config.agentKind,
    name: input.name,
    description: input.description,
    capabilities: input.capabilities ?? [],
    visibility: input.visibility ?? 'org',
    discoverable: input.discoverable ?? false,
    acceptsDelegation: input.acceptsDelegation ?? false,
    // owner is derived from the token (enforced by the Hub); never sent here.
  };
  const r = await call<{ agent: unknown }>('/api/agents/register', { method: 'POST', body: JSON.stringify(body) });
  registered = true;
  return r.agent;
}

export async function heartbeat(): Promise<boolean> {
  requireRegistration();
  try {
    await call(`/api/agents/${encodeURIComponent(config.agentId)}/heartbeat`, { method: 'POST' });
    return true;
  } catch {
    return false;
  }
}

export async function discover(capability?: string): Promise<unknown[]> {
  const q = capability ? `?capability=${encodeURIComponent(capability)}` : '';
  const r = await call<{ agents: unknown[] }>(`/api/agents/discover${q}`);
  return r.agents;
}

export interface InboxMessage {
  id: string;
  fromAgent: string;
  toAgent: string;
  capability: string | null;
  body: string;
  replyTo: string | null;
  createdAt: string;
}

export type A2ATaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_REJECTED'
  | 'TASK_STATE_AUTH_REQUIRED';

export interface A2APart {
  text?: string;
  raw?: string;
  url?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
  filename?: string;
  mediaType?: string;
}

export interface A2AMessage {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2AArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2APart[];
  metadata?: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  contextId: string;
  status: {
    state: A2ATaskState;
    message?: A2AMessage;
    timestamp: string;
  };
  artifacts?: A2AArtifact[];
  history?: A2AMessage[];
  metadata?: Record<string, unknown>;
}

export type DeliveryEvent =
  | { type: 'message'; message: InboxMessage }
  | { type: 'task'; task: A2ATask };

const STOPPED_TASK_STATES = new Set<A2ATaskState>([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_AUTH_REQUIRED',
]);

function parseDeliveryEvent(frame: string): DeliveryEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (!['message', 'task'].includes(event) || data.length === 0) return null;
  try {
    const value = JSON.parse(data.join('\n')) as InboxMessage | A2ATask;
    if (!value || typeof value.id !== 'string') return null;
    if (event === 'message') {
      const message = value as InboxMessage;
      if (typeof message.fromAgent !== 'string') return null;
      return { type: 'message', message };
    }
    const task = value as A2ATask;
    if (typeof task.contextId !== 'string' || typeof task.status?.state !== 'string') return null;
    return { type: 'task', task };
  } catch {
    return null;
  }
}

/**
 * Subscribe to one agent's durable inbox over SSE. The Hub replays every unacked message on
 * reconnect, so consumers must deduplicate by message id and ack only after successful handling.
 */
export async function* streamEvents(
  agentId: string,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<DeliveryEvent> {
  const res = await fetch(`${config.baseUrl}/api/agents/${encodeURIComponent(agentId)}/events`, {
    headers: { ...authHeaders(), Accept: 'text/event-stream' },
    signal: opts.signal,
  });
  if (!res.ok) throw await responseError(res);
  if (!res.body) throw new Error('Hub event stream returned no response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parseDeliveryEvent(frame);
        if (event) yield event;
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Backward-compatible message-only view used by inbox/wait callers. */
export async function* streamInbox(
  agentId: string,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<InboxMessage> {
  for await (const event of streamEvents(agentId, opts)) {
    if (event.type === 'message') yield event.message;
  }
}

/** Hold one MCP tool call until a message arrives; suitable for an active agent turn. */
export async function waitForMessage(timeoutSeconds = 30): Promise<InboxMessage | null> {
  requireRegistration();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  timer.unref();
  try {
    for await (const message of streamInbox(config.agentId, { signal: controller.signal })) {
      return message;
    }
    return null;
  } catch (error) {
    if (controller.signal.aborted) return null;
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Send a directed message from the identity explicitly registered by this MCP session. */
export async function sendMessage(input: {
  to: string;
  body: string;
  capability?: string;
  replyTo?: string;
}): Promise<InboxMessage> {
  requireRegistration();
  const r = await call<{ message: InboxMessage }>(
    `/api/agents/${encodeURIComponent(input.to)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        from: config.agentId,
        body: input.body,
        capability: input.capability,
        replyTo: input.replyTo,
      }),
    },
  );
  return r.message;
}

/** Read your own inbox (unread only by default). */
export async function fetchInbox(opts: { unreadOnly?: boolean; limit?: number } = {}): Promise<InboxMessage[]> {
  requireRegistration();
  const params = new URLSearchParams();
  if (opts.unreadOnly === false) params.set('unread', 'false');
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const r = await call<{ messages: InboxMessage[] }>(
    `/api/agents/${encodeURIComponent(config.agentId)}/inbox${qs ? `?${qs}` : ''}`,
  );
  return r.messages;
}

/** Mark a message in your inbox as read. */
export async function ackMessage(messageId: string): Promise<boolean> {
  requireRegistration();
  return ackMessageFor(config.agentId, messageId);
}

/** CLI/runtime-adapter variant: Hub ownership + registration checks remain authoritative. */
export async function ackMessageFor(agentId: string, messageId: string): Promise<boolean> {
  await call(`/api/agents/${encodeURIComponent(agentId)}/messages/${encodeURIComponent(messageId)}/ack`, {
    method: 'POST',
  });
  return true;
}

export function isTaskStopped(task: A2ATask): boolean {
  return STOPPED_TASK_STATES.has(task.status.state);
}

/** Create an official A2A v1 Task against a registered Agent Card. */
export async function delegateTask(input: {
  to: string;
  body: string;
  capability?: string;
  contextId?: string;
  taskId?: string;
}): Promise<A2ATask> {
  requireRegistration();
  const message: Record<string, unknown> = {
    messageId: randomUUID(),
    role: 'ROLE_USER',
    parts: [{ text: input.body, mediaType: 'text/plain' }],
  };
  if (input.contextId) message.contextId = input.contextId;
  if (input.taskId) message.taskId = input.taskId;
  const response = await call<{ task: A2ATask }>(
    `/api/agents/${encodeURIComponent(input.to)}/a2a/message:send`,
    {
      method: 'POST',
      headers: { Accept: 'application/a2a+json', 'A2A-Version': '1.0' },
      body: JSON.stringify({
        message,
        configuration: { returnImmediately: true },
        metadata: {
          agentCenter: {
            sourceAgentId: config.agentId,
            ...(input.capability ? { requestedCapability: input.capability } : {}),
          },
        },
      }),
    },
    'application/a2a+json',
  );
  return response.task;
}

export async function getTask(targetAgentId: string, taskId: string): Promise<A2ATask> {
  return call<A2ATask>(
    `/api/agents/${encodeURIComponent(targetAgentId)}/a2a/tasks/${encodeURIComponent(taskId)}`,
    { headers: { Accept: 'application/a2a+json', 'A2A-Version': '1.0' } },
  );
}

export async function cancelTask(targetAgentId: string, taskId: string): Promise<A2ATask> {
  return call<A2ATask>(
    `/api/agents/${encodeURIComponent(targetAgentId)}/a2a/tasks/${encodeURIComponent(taskId)}:cancel`,
    { method: 'POST', headers: { Accept: 'application/a2a+json', 'A2A-Version': '1.0' } },
  );
}

/** Recipient connector status bridge. Agent Center constructs valid agent-role Message/Artifact objects. */
export async function updateTaskFor(
  agentId: string,
  taskId: string,
  input: { state: A2ATaskState; message?: string; result?: string },
): Promise<A2ATask> {
  const message = input.message ?? input.result;
  const body: Record<string, unknown> = { state: input.state };
  if (message) {
    body.message = {
      messageId: randomUUID(),
      role: 'ROLE_AGENT',
      parts: [{ text: message, mediaType: 'text/plain' }],
    };
  }
  if (input.result) {
    body.artifacts = [
      {
        artifactId: randomUUID(),
        name: 'result',
        parts: [{ text: input.result, mediaType: 'text/plain' }],
      },
    ];
  }
  const response = await call<{ task: A2ATask }>(
    `/api/agents/${encodeURIComponent(agentId)}/a2a-connector/tasks/${encodeURIComponent(taskId)}/status`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return response.task;
}

/** Wait on the official task subscription stream; terminal-before-subscribe races resolve via GET. */
export async function waitForTask(
  targetAgentId: string,
  taskId: string,
  timeoutSeconds: number,
): Promise<A2ATask> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  timeout.unref();
  try {
    const res = await fetch(
      `${config.baseUrl}/api/agents/${encodeURIComponent(targetAgentId)}/a2a/tasks/${encodeURIComponent(taskId)}:subscribe`,
      {
        method: 'POST',
        headers: { ...authHeaders(false), Accept: 'text/event-stream', 'A2A-Version': '1.0' },
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      const task = await getTask(targetAgentId, taskId);
      if (isTaskStopped(task)) return task;
      throw await responseError(res);
    }
    if (!res.body) throw new Error('Hub task stream returned no response body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        const payload = JSON.parse(data) as {
          task?: A2ATask;
          statusUpdate?: { status?: { state?: A2ATaskState } };
        };
        if (payload.task && isTaskStopped(payload.task)) return payload.task;
        if (payload.statusUpdate?.status?.state && STOPPED_TASK_STATES.has(payload.statusUpdate.status.state)) {
          return getTask(targetAgentId, taskId);
        }
      }
      if (done) return getTask(targetAgentId, taskId);
    }
  } catch (error) {
    if (controller.signal.aborted) return getTask(targetAgentId, taskId);
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
