// Hub HTTP client (all outbound, NAT-friendly). register / heartbeat / discover / send / inbox / ack.
import { config } from './config.js';

export interface Capability {
  name: string;
  description?: string;
}

async function call<T>(path: string, init: RequestInit = {}, token = config.token): Promise<T> {
  if (!token) throw new Error('AGENT_CENTER_TOKEN not set (run `agent-center login`, or set the env var)');
  // Only send Content-Type when there's a body — a bodyless POST/DELETE (e.g. heartbeat) with
  // Content-Type: application/json makes strict JSON parsers reject an empty body as a 400.
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.body != null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10000),
    headers: { ...headers, ...init.headers },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = data?.error ? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error)) : res.statusText;
    throw new Error(`Hub ${res.status}: ${detail}`);
  }
  return data as T;
}

export interface IdentityInput {
  id: string;
  kind: 'nomad' | 'cowork' | 'personal';
  name: string;
}

/** Provision the private identity used for send/inbox without publishing capabilities. */
export async function ensureIdentity(
  identity: IdentityInput = { id: config.agentId, kind: config.agentKind, name: config.agentName },
  token = config.token,
): Promise<unknown> {
  const r = await call<{ agent: unknown }>(
    '/api/agents/ensure',
    { method: 'POST', body: JSON.stringify(identity) },
    token,
  );
  return r.agent;
}

export async function register(input: {
  name: string;
  description?: string;
  capabilities: Capability[];
  visibility?: 'owner' | 'org' | 'public';
}): Promise<unknown> {
  const body = {
    id: config.agentId,
    kind: config.agentKind,
    name: input.name,
    description: input.description,
    capabilities: input.capabilities,
    visibility: input.visibility ?? 'org',
    // owner is derived from the token (enforced by the Hub); never sent here.
  };
  const r = await call<{ agent: unknown }>('/api/agents/register', { method: 'POST', body: JSON.stringify(body) });
  return r.agent;
}

export async function heartbeat(): Promise<boolean> {
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

/** Send a directed message to an agent. from = the private identity provisioned at login/startup. */
export async function sendMessage(input: {
  to: string;
  body: string;
  capability?: string;
  replyTo?: string;
}): Promise<InboxMessage> {
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
  await call(`/api/agents/${encodeURIComponent(config.agentId)}/messages/${encodeURIComponent(messageId)}/ack`, {
    method: 'POST',
  });
  return true;
}
