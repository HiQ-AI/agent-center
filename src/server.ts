#!/usr/bin/env node
/**
 * Agent Center connector — stdio MCP server. Run via `npx -y -p @hiq-ai/agent-center agent-center-mcp`.
 * Lets any agent (Claude Code / Cortex Cowork / your own) join the Cortex Agent Center Hub:
 * register a session, find other agents (discover), delegate directly (send),
 * pull work (inbox), self-check (whoami). All outbound HTTP — no inbound, NAT-friendly.
 * The host injects AGENT_CENTER_URL / AGENT_CENTER_TOKEN / AGENT_ID / AGENT_NAME / AGENT_KIND via env.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from './config.js';
import {
  claudeChannelEnabled,
  claudeChannelServerOptions,
  startClaudeChannel,
  stopClaudeChannel,
} from './claudeChannel.js';
import {
  register,
  heartbeat,
  discover,
  sendMessage,
  fetchInbox,
  ackMessage,
  waitForMessage,
  isRegistered,
} from './hubClient.js';

const VERSION = '0.0.3';

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

const server = new McpServer(
  { name: 'agent-center', version: VERSION },
  claudeChannelServerOptions(),
);

server.registerTool(
  'agent_center_register',
  {
    title: 'Register this Agent Center session',
    description:
      'Register this MCP session as a distinct agent. Required before send/inbox/heartbeat; login only authorizes the owner. Capabilities may be empty, discoverability is optional, and unsolicited delegation is disabled by default.',
    inputSchema: {
      name: z.string().describe('Public display name (e.g. "Tris", "helix expert")'),
      description: z.string().optional().describe('One line on what you can do'),
      capabilities: z
        .array(z.object({ name: z.string(), description: z.string().optional() }))
        .optional()
        .describe('Skills to publish, e.g. [{name:"lca-bom-match",description:"BOM matching"}]; default: []'),
      visibility: z.enum(['owner', 'org', 'public']).optional().describe('Who can see you (default: org)'),
      discoverable: z.boolean().optional().describe('Publish this Agent Card in discover results (default: false)'),
      accepts_delegation: z
        .boolean()
        .optional()
        .describe('Accept unsolicited messages (default: false). Enable only when this runtime has a dispatcher that wakes the agent and drains inbox.'),
    },
  },
  async (args) => {
    try {
      const agent = await register({
        name: args.name,
        description: args.description,
        capabilities: args.capabilities ?? [],
        visibility: args.visibility,
        discoverable: args.discoverable,
        acceptsDelegation: args.accepts_delegation,
      });
      startHeartbeat();
      startClaudeChannel(server);
      return ok(
        `Registered session ${config.agentId}.\n` +
          `  capabilities      : ${args.capabilities?.length ?? 0}\n` +
          `  discoverable      : ${args.discoverable ?? false}\n` +
          `  accepts delegation: ${args.accepts_delegation ?? false}\n` +
          `${JSON.stringify(agent)}`,
      );
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
      'Send a task or question from this registered session to another agent (get its id from discover first). The recipient must accept delegation unless this is a validated reply.',
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
      'Pull messages for this registered session (unread only by default). MCP does not portably wake an idle host agent; a runtime accepting delegation needs its own dispatcher to call this tool and start a turn.',
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
  'agent_center_wait',
  {
    title: 'Wait for an Agent Center message',
    description:
      'Hold this tool call until one message arrives for the registered session or the timeout expires. Use during an active turn instead of polling. This does not wake an idle host; host-specific integrations handle that.',
    inputSchema: {
      timeout_seconds: z.number().int().min(1).max(50).optional().describe('Wait duration (default 30 seconds, max 50)'),
    },
  },
  async (args) => {
    try {
      const message = await waitForMessage(args.timeout_seconds ?? 30);
      if (!message) return ok('No message arrived before the timeout.');
      return ok(
        `Message [${message.id}] from ${message.fromAgent}` +
          `${message.capability ? ` (capability: ${message.capability})` : ''}` +
          `${message.replyTo ? ` ↩︎${message.replyTo}` : ''}:\n${message.body}\n\n` +
          `Handle it idempotently, then call agent_center_ack(message_id="${message.id}").`,
      );
    } catch (e) {
      return fail(`Wait failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  'agent_center_ack',
  {
    title: 'Acknowledge one Agent Center message',
    description: 'Mark one inbox message as handled. Ack only after its work/reply has completed successfully.',
    inputSchema: {
      message_id: z.string().describe('Message id returned by inbox/wait/channel delivery'),
    },
  },
  async (args) => {
    try {
      await ackMessage(args.message_id);
      return ok(`Acknowledged ${args.message_id}.`);
    } catch (e) {
      return fail(`Ack failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  'agent_center_whoami',
  {
    title: 'Check connection status',
    description: 'Show owner authorization, this MCP process session id, registration state, and Hub reachability.',
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
        `  registered: ${isRegistered() ? '✅ yes' : '❌ no (call agent_center_register)'}\n` +
        `  hub     : ${config.baseUrl}\n` +
        `  reachable: ${reachable ? '✅ yes' : '❌ no (token may be revoked, or Hub unreachable)'}`,
    );
  },
);

async function probeReachable(): Promise<boolean> {
  // discover only requires owner authorization, so it distinguishes connectivity from registration.
  try {
    await discover();
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  process.stderr.write(
    `[agent-center-mcp ${VERSION}] Hub=${config.baseUrl} id=${config.agentId}` +
      `${claudeChannelEnabled ? ' channel=claude' : ''}` +
      `${config.token ? '' : ' ⚠️ AGENT_CENTER_TOKEN not set'}\n`,
  );
  await server.connect(new StdioServerTransport());
  if (isRegistered()) {
    startHeartbeat();
    startClaudeChannel(server);
  }
}

process.once('SIGINT', stopClaudeChannel);
process.once('SIGTERM', stopClaudeChannel);

main().catch((e) => {
  process.stderr.write(`[agent-center-mcp] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
