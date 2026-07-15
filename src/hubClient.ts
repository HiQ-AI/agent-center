// Hub HTTP 客户端(全出站,NAT 免谈)。register / heartbeat / discover。
import { config } from './config.js';

export interface Capability {
  name: string;
  description?: string;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!config.token) throw new Error('未配置 AGENT_CENTER_TOKEN(在 warden「接入」页发放一枚)');
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}`, ...init.headers },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = data?.error ? (typeof data.error === 'string' ? data.error : JSON.stringify(data.error)) : res.statusText;
    throw new Error(`Hub ${res.status}: ${detail}`);
  }
  return data as T;
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
    // owner 由 token 决定(Hub 强制),这里不传。
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
