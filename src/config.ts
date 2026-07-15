import { hostname, userInfo } from 'node:os';
import { loadAuth } from './authStore.js';

/** 连接器配置:优先 `~/.agent-center/auth.json`(CLI login 写入),回落 env。 */
function sanitize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

const stored = loadAuth();

const hubUrl = (stored?.hubUrl ?? process.env.AGENT_CENTER_URL ?? 'https://lab.hiq.earth/deck/hub').replace(/\/$/, '');
const defaultId = process.env.AGENT_ID
  ? sanitize(process.env.AGENT_ID)
  : sanitize(`${userInfo().username}-${hostname()}`);

export const config = {
  // 运行时 Hub 基址(register/discover)。
  baseUrl: hubUrl,
  // per-agent 接入 token。login 后来自 auth.json;否则 env。空 = 未登录。
  token: stored?.token ?? process.env.AGENT_CENTER_TOKEN ?? '',
  // 归属(Cortex user_id)——登录后才有。
  owner: stored?.owner ?? '',
  // 本 agent 稳定标识 / 展示名 / 类别。
  agentId: stored?.agentId ?? defaultId,
  agentName: stored?.agentName ?? process.env.AGENT_NAME ?? 'CLI Agent',
  agentKind: (process.env.AGENT_KIND ?? 'personal') as 'nomad' | 'cowork' | 'personal',
  // 设备授权(device flow)走 deck。
  deckBase: (process.env.DECK_BASE ?? 'https://lab.hiq.earth/deck').replace(/\/$/, ''),
};
