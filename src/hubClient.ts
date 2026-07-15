// Hub HTTP client (all outbound, NAT-friendly). register / heartbeat / discover / send / inbox / stream / ack.
import { config } from './config.js';

export interface Capability {
  name: string;
  description?: string;
}

function authHeaders(hasBody = false): Record<string, string> {
  const token = config.token;
  if (!token) throw new Error('AGENT_CENTER_TOKEN not set (run `agent-center login`, or set the env var)');
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (hasBody) headers['Content-Type'] = 'application/json';
  return headers;
}

async function responseError(res: Response): Promise<Error> {
  const text = await res.text();
  let detail = res.statusText;
  if (text) {
    try {
      const data = JSON.parse(text) as { error?: unknown };
      if (typeof data.error === 'string') detail = data.error;
      else if (data.error !== undefined) detail = JSON.stringify(data.error);
    } catch {
      detail = text;
    }
  }
  return new Error(`Hub ${res.status}: ${detail}`);
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Only send Content-Type when there's a body — a bodyless POST/DELETE (e.g. heartbeat) with
  // Content-Type: application/json makes strict JSON parsers reject an empty body as a 400.
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10000),
    headers: { ...authHeaders(init.body != null), ...init.headers },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = data?.error ? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error)) : res.statusText;
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

function parseMessageEvent(frame: string): InboxMessage | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  if (event !== 'message' || data.length === 0) return null;
  try {
    const value = JSON.parse(data.join('\n')) as InboxMessage;
    if (!value || typeof value.id !== 'string' || typeof value.fromAgent !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Subscribe to one agent's durable inbox over SSE. The Hub replays every unacked message on
 * reconnect, so consumers must deduplicate by message id and ack only after successful handling.
 */
export async function* streamInbox(
  agentId: string,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<InboxMessage> {
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
        const message = parseMessageEvent(frame);
        if (message) yield message;
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
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
