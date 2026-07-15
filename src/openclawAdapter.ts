#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createShutdownController, formatInboundTask, runDeliveryStream } from './deliveryAdapter.js';
import type { InboxMessage } from './hubClient.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function openClawRequestBody(message: InboxMessage, openClawAgent: string): Record<string, unknown> {
  return {
    name: 'Agent Center',
    agentId: openClawAgent,
    message: formatInboundTask(message),
    wakeMode: 'now',
    deliver: false,
  };
}

export async function wakeOpenClaw(
  message: InboxMessage,
  options: { url: string; token: string; openClawAgent: string },
): Promise<void> {
  const response = await fetch(options.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(openClawRequestBody(message, options.openClawAgent)),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`OpenClaw webhook ${response.status}: ${await response.text()}`);
  }
}

async function main(): Promise<void> {
  const agentId = arg('agent-id');
  const token = process.env.OPENCLAW_HOOK_TOKEN;
  if (!agentId || !token) {
    process.stderr.write(
      'Usage: OPENCLAW_HOOK_TOKEN=<dedicated-token> agent-center-openclaw --agent-id <registered-id> [--openclaw-agent main] [--url http://127.0.0.1:18789/hooks/agent]\n',
    );
    process.exitCode = 2;
    return;
  }

  const controller = createShutdownController();
  const options = {
    url: arg('url') ?? process.env.OPENCLAW_HOOK_URL ?? 'http://127.0.0.1:18789/hooks/agent',
    token,
    openClawAgent: arg('openclaw-agent') ?? 'main',
  };
  process.stderr.write(
    `[agent-center-openclaw] Hub=${config.baseUrl} agent=${agentId} openclaw-agent=${options.openClawAgent}\n`,
  );
  await runDeliveryStream(
    agentId,
    (message) => wakeOpenClaw(message, options),
    controller.signal,
    (message) => process.stderr.write(`[agent-center-openclaw] ${message}\n`),
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`[agent-center-openclaw] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
