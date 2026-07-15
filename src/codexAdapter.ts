#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createShutdownController, formatInboundTask, runDeliveryStream } from './deliveryAdapter.js';
import type { InboxMessage } from './hubClient.js';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function codexResumeArgs(sessionId: string): string[] {
  return ['exec', 'resume', '--skip-git-repo-check', sessionId, '-'];
}

export function resumeCodexSession(
  message: InboxMessage,
  options: { agentId: string; sessionId: string; cwd: string; codexBin: string; signal?: AbortSignal },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.codexBin, codexResumeArgs(options.sessionId), {
      cwd: options.cwd,
      env: {
        ...process.env,
        AGENT_ID: options.agentId,
        AGENT_CENTER_ATTACHED: '1',
      },
      stdio: ['pipe', 'inherit', 'inherit'],
      signal: options.signal,
    });
    child.once('error', reject);
    child.stdin.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`codex exec resume exited with ${code ?? signal ?? 'unknown status'}`));
    });
    child.stdin.end(formatInboundTask(message));
  });
}

async function main(): Promise<void> {
  const agentId = arg('agent-id');
  const sessionId = arg('session-id') ?? process.env.CODEX_THREAD_ID;
  if (!agentId || !sessionId) {
    process.stderr.write(
      'Usage: agent-center-codex --agent-id <registered-id> --session-id <codex-thread-id> [--cwd <path>]\n',
    );
    process.exitCode = 2;
    return;
  }

  const controller = createShutdownController();
  const options = {
    agentId,
    sessionId,
    cwd: arg('cwd') ?? process.cwd(),
    codexBin: process.env.CODEX_BIN ?? 'codex',
    signal: controller.signal,
  };
  process.stderr.write(`[agent-center-codex] Hub=${config.baseUrl} agent=${agentId} session=${sessionId}\n`);
  await runDeliveryStream(
    agentId,
    (message) => resumeCodexSession(message, options),
    controller.signal,
    (message) => process.stderr.write(`[agent-center-codex] ${message}\n`),
  );
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`[agent-center-codex] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
