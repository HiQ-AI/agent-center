import { randomUUID } from 'node:crypto';
import { loadAuth } from './authStore.js';

/** Connector config: prefer `~/.agent-center/auth.json` (written by CLI login), fall back to env. */
function sanitize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

const stored = loadAuth();

const hubUrl = (stored?.hubUrl ?? process.env.AGENT_CENTER_URL ?? 'https://lab.hiq.earth/deck/hub').replace(/\/$/, '');
// One identity per MCP process/session. AGENT_ID is an explicit host override; otherwise a fresh
// id is generated on every process start and registration remains an explicit agent action.
const sessionAgentId = process.env.AGENT_ID
  ? sanitize(process.env.AGENT_ID)
  : `session-${randomUUID()}`;

export const config = {
  // Runtime Hub base (register/discover/send/inbox).
  baseUrl: hubUrl,
  // Owner-level access token. From auth.json after login; otherwise env. Empty = not logged in.
  token: stored?.token ?? process.env.AGENT_CENTER_TOKEN ?? '',
  // Owner (Cortex user_id) — only present after login.
  owner: stored?.owner ?? '',
  // This MCP process/session's identity. It does not exist in the Hub until register succeeds.
  agentId: sessionAgentId,
  agentName: process.env.AGENT_NAME ?? 'Session Agent',
  agentKind: (process.env.AGENT_KIND ?? 'personal') as 'nomad' | 'cowork' | 'personal',
  // Device authorization (device flow) goes through deck.
  deckBase: (process.env.DECK_BASE ?? 'https://lab.hiq.earth/deck').replace(/\/$/, ''),
};
