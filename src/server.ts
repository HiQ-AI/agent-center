#!/usr/bin/env node
/**
 * Agent Center 连接器 —— stdio MCP server。`npx -y @hiq-ai/agent-center-mcp` 运行。
 * 让任意 agent(Claude Code / Cortex Cowork / 自建)接入 Cortex Agent Center Hub:
 * 声明能力(register)、发现别的 agent(discover)。全出站 HTTP,无入站、NAT 免谈。
 * host 经 env 注入 AGENT_CENTER_URL / AGENT_CENTER_TOKEN / AGENT_ID / AGENT_NAME / AGENT_KIND。
 * A2A 定向消息(send / inbox)随 Hub 的 P-C 能力开放后加。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { config } from './config.js';
import { register, heartbeat, discover } from './hubClient.js';

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
    title: '接入 Agent Center',
    description:
      '把自己接入 Cortex Agent Center 并声明能力,让别的 agent 能发现你。首次互联前调用一次;能力/名字变了再调更新。',
    inputSchema: {
      name: z.string().describe('对外展示名(如「翠丝」「helix 专家」)'),
      description: z.string().optional().describe('一句话说明你能干什么'),
      capabilities: z
        .array(z.object({ name: z.string(), description: z.string().optional() }))
        .describe('可被别人委派的技能清单,如 [{name:"lca-bom-match",description:"BOM 匹配"}]'),
      visibility: z.enum(['owner', 'org', 'public']).optional().describe('可见范围(默认 org)'),
    },
  },
  async (args) => {
    try {
      const agent = await register(args);
      startHeartbeat();
      return ok(`已接入 Agent Center(id=${config.agentId})。声明了 ${args.capabilities.length} 项能力,现在别的 agent 能发现你了。\n${JSON.stringify(agent)}`);
    } catch (e) {
      return fail(`接入失败:${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  'agent_center_discover',
  {
    title: '发现 agent',
    description: '在 Agent Center 里找「谁能做某件事」。给能力名精确匹配;不给则列出所有可见 agent。',
    inputSchema: {
      capability: z.string().optional().describe('要找的能力名,如 "lca-bom-match";留空 = 列全部'),
    },
  },
  async (args) => {
    try {
      const agents = await discover(args.capability);
      if (agents.length === 0) return ok(args.capability ? `没有 agent 声明能力「${args.capability}」。` : '目录里还没有别的 agent。');
      return ok(`找到 ${agents.length} 个:\n${JSON.stringify(agents, null, 1)}`);
    } catch (e) {
      return fail(`发现失败:${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

async function main(): Promise<void> {
  process.stderr.write(`[agent-center-mcp ${VERSION}] Hub=${config.baseUrl} id=${config.agentId}${config.token ? '' : ' ⚠️ 未配置 AGENT_CENTER_TOKEN'}\n`);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`[agent-center-mcp] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
