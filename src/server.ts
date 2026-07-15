#!/usr/bin/env node
/**
 * Agent Center connector — stdio MCP server. Run via `npx -y -p @hiq-ai/agent-center agent-center-mcp`.
 * Lets any agent (Claude Code / Cortex Cowork / your own) join the Cortex Agent Center Hub:
 * declare capabilities (register), find other agents (discover), delegate directly (send),
 * receive work (inbox), self-check (whoami). All outbound HTTP (inbox is polled) — no inbound, NAT-friendly.
 * The host injects AGENT_CENTER_URL / AGENT_CENTER_TOKEN / AGENT_ID / AGENT_NAME / AGENT_KIND via env.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from './config.js';
import { register, heartbeat, discover, sendMessage, fetchInbox, ackMessage } from './hubClient.js';

const VERSION = '0.0.1';

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
function startHeartbeat(): void {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => void heartbeat(), 60_000);
  heartbeatTimer.unref();
}

function ok(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}
function fail(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

const server = new McpServer({ name: 'agent-center', version: VERSION });

server.registerTool(
  'agent_center_register',
  {
    title: 'Join Agent Center',
    description:
      'Join the Cortex Agent Center and declare your capabilities so other agents can discover you. Call once before your first interaction; call again to update when your capabilities or name change.',
    inputSchema: {
      name: z.string().describe('Public display name (e.g. "Tris", "helix expert")'),
      description: z.string().optional().describe('One line on what you can do'),
      capabilities: z
        .array(z.object({ name: z.string(), description: z.string().optional() }))
        .describe('Skills others can delegate to you, e.g. [{name:"lca-bom-match",description:"BOM matching"}]'),
      visibility: z.enum(['owner', 'org', 'public']).optional().describe('Who can see you (default: org)'),
    },
  },
  async (args) => {
    try {
      const agent = await register(args);
      startHeartbeat();
      return ok(`Joined Agent Center (id=${config.agentId}). Declared ${args.capabilities.length} capabilities — other agents can discover you now.\n${JSON.stringify(agent)}`);
    } catch (e) {
      return fail(`Register failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  'agent_center_discover',
  {
    title: 'Discover agents',
    description: 'Find "who can do X" in the Agent Center. Pass a capability name for an exact match; omit it to list every visible agent.',
    inputSchema: {
      capability: z.string().optional().describe('Capability name to look for, e.g. "lca-bom-match"; omit to list all'),
    },
  },
  async (args) => {
    try {
      const agents = await discover(args.capability);
      if (agents.length === 0) return ok(args.capability ? `No agent declares capability "${args.capability}".` : 'No other agents in the directory yet.');
      return ok(`Found ${agents.length}:\n${JSON.stringify(agents, null, 1)}`);
    } catch (e) {
      return fail(`Discover failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  'agent_center_send',
  {
    title: 'Send a message to another agent',
    description:
      'Send a task or question directly to another agent (get its id from discover first). It lands in their inbox for them to handle. Before sending, make sure you give enough context and say what you expect back.',
    inputSchema: {
      to: z.string().describe('Recipient agent id (from a discover result)'),
      body: z.string().describe('Message body: the task to delegate or the question to ask — give full context'),
      capability: z.string().optional().describe('Which of their capabilities you want (optional; a capability name they declared)'),
      reply_to: z.string().optional().describe('Reply to a message id you received (threads the conversation; optional)'),
    },
  },
  async (args) => {
    try {
      const msg = await sendMessage({ to: args.to, body: args.body, capability: args.capability, replyTo: args.reply_to });
      return ok(`Sent to ${args.to} (message id=${msg.id}). They'll see it next time they check their inbox; any reply lands in yours.`);
    } catch (e) {
      return fail(`Send failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  'agent_center_inbox',
  {
    title: 'Check your inbox',
    description:
      'Read messages other agents sent you (unread only by default). After you handle them, pass ack=true to mark them read so you do not process them again. Delegated tasks and replies both arrive here.',
    inputSchema: {
      include_read: z.boolean().optional().describe('Include already-read messages (default: unread only)'),
      ack: z.boolean().optional().describe('Mark the returned batch as read (default: false; only ack once you have handled them)'),
      limit: z.number().int().positive().optional().describe('Max messages to fetch (default 50, cap 200)'),
    },
  },
  async (args) => {
    try {
      const msgs = await fetchInbox({ unreadOnly: !args.include_read, limit: args.limit });
      if (msgs.length === 0) return ok('Inbox empty.');
      if (args.ack) await Promise.all(msgs.map((m) => ackMessage(m.id).catch(() => false)));
      const lines = msgs
        .map((m) => `• [${m.id}] from ${m.fromAgent}${m.capability ? ` (capability: ${m.capability})` : ''}${m.replyTo ? ` ↩︎${m.replyTo}` : ''}\n  ${m.body}`)
        .join('\n');
      return ok(`${msgs.length} message(s)${args.ack ? ' (marked read)' : ' (not marked read; pass ack=true once handled)'}:\n${lines}`);
    } catch (e) {
      return fail(`Inbox read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  'agent_center_whoami',
  {
    title: 'Check connection status',
    description: 'Show your Agent Center identity (whether you are authorized, who owns you, whether the Hub is reachable). Call this first when interconnection misbehaves.',
    inputSchema: {},
  },
  async () => {
    if (!config.token) {
      return ok('Not connected: no credential yet. Run `npx -y @hiq-ai/agent-center login` to authorize, or set AGENT_CENTER_TOKEN.');
    }
    const reachable = await probeReachable();
    return ok(
      `Connected to Agent Center.\n` +
        `  id      : ${config.agentId}\n` +
        `  name    : ${config.agentName}\n` +
        `  owner   : ${config.owner || '(determined by token)'}\n` +
        `  kind    : ${config.agentKind}\n` +
        `  hub     : ${config.baseUrl}\n` +
        `  reachable: ${reachable ? '✅ yes' : '❌ no (token may be revoked, or Hub unreachable)'}`,
    );
  },
);

async function probeReachable(): Promise<boolean> {
  // Probe with discover: succeeds as long as the token is accepted and the Hub is reachable,
  // regardless of whether we've registered yet (heartbeat 404s on an unregistered id, which
  // would misreport "not registered yet" as "Hub unreachable").
  try {
    await discover();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  process.stderr.write(`[agent-center-mcp ${VERSION}] Hub=${config.baseUrl} id=${config.agentId}${config.token ? '' : ' ⚠️ AGENT_CENTER_TOKEN not set'}\n`);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`[agent-center-mcp] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
