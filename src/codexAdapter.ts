#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { config } from './config.js';
import { createShutdownController, formatInboundTask, runDeliveryStream } from './deliveryAdapter.js';
import {
  ackMessageFor,
  getTask,
  isTaskStopped,
  updateTaskFor,
  type DeliveryEvent,
} from './hubClient.js';

interface RpcResponse {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
  params?: Record<string, unknown>;
}

interface AgentMessageItem {
  id: string;
  type: 'agentMessage';
  text: string;
  phase?: 'commentary' | 'final_answer' | null;
}

export interface TurnCompletion {
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  finalText: string;
  error?: string;
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function codexAppServerArgs(): string[] {
  return ['app-server', '--listen', 'stdio://'];
}

export function assertIdleCodexThread(resumeResult: unknown): void {
  const status = (resumeResult as { thread?: { status?: { type?: unknown } } } | null)?.thread?.status?.type;
  if (status === 'idle') return;
  if (status === 'active') {
    throw new Error(
      'Codex thread is active in another client; stop the interactive turn before starting agent-center-codex',
    );
  }
  throw new Error(`Codex thread is not ready for headless delivery (status=${String(status ?? 'unknown')})`);
}

export function assertCodexThreadCanResume(readResult: unknown): void {
  const turns = (readResult as {
    thread?: { turns?: Array<{ status?: unknown }> };
  } | null)?.thread?.turns;
  const latestStatus = turns?.at(-1)?.status;
  if (latestStatus === 'completed' || latestStatus === 'failed') return;
  throw new Error(
    `Codex thread latest turn is ${String(latestStatus ?? 'unknown')}; ` +
    'finish the interactive turn and exit its client before starting agent-center-codex',
  );
}

export function headlessServerRequestReply(message: RpcResponse): Record<string, unknown> | undefined {
  if (message.id === undefined || !message.method) return undefined;
  if (message.method === 'mcpServer/elicitation/request') {
    const params = message.params as {
      serverName?: unknown;
      mode?: unknown;
      _meta?: { codex_approval_kind?: unknown } | null;
    } | undefined;
    const trustedAgentCenterTool = params?.serverName === 'agent-center'
      && params.mode === 'form'
      && params._meta?.codex_approval_kind === 'mcp_tool_call';
    return {
      id: message.id,
      result: trustedAgentCenterTool
        ? { action: 'accept', content: {}, _meta: null }
        : { action: 'cancel', content: null, _meta: null },
    };
  }
  return {
    id: message.id,
    error: { code: -32601, message: `Unsupported headless client request: ${message.method}` },
  };
}

export function completedCodexResult(completion: TurnCompletion): string | undefined {
  if (completion.status !== 'completed') return undefined;
  const text = completion.finalText.trim();
  return text || undefined;
}

export function finalAgentMessageText(items: AgentMessageItem[]): string {
  const finalAnswers = items.filter((item) => item.phase === 'final_answer');
  return (finalAnswers.length > 0 ? finalAnswers : items)
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join('\n');
}

function agentMessageItem(value: unknown, fallbackId?: string): AgentMessageItem | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (item.type !== 'agentMessage' || typeof item.text !== 'string') return undefined;
  const id = typeof item.id === 'string' ? item.id : fallbackId;
  if (!id) return undefined;
  const phase = item.phase === 'commentary' || item.phase === 'final_answer' || item.phase === null
    ? item.phase
    : undefined;
  return { id, type: 'agentMessage', text: item.text, phase };
}

/** Long-lived Codex app-server stdio client: one initialize/resume, then one turn per delivery. */
export class CodexAppServerClient {
  private readonly child: ReturnType<typeof spawn>;
  private requestId = 0;
  private readonly pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly turnWaiters = new Map<string, (completion: TurnCompletion) => void>();
  private readonly completedTurns = new Map<string, TurnCompletion>();
  private readonly turnAgentMessages = new Map<string, Map<string, AgentMessageItem>>();
  private stopped = false;

  constructor(
    private readonly options: {
      agentId: string;
      sessionId: string;
      cwd: string;
      codexBin: string;
      signal?: AbortSignal;
      log?: (message: string) => void;
    },
  ) {
    this.child = spawn(options.codexBin, codexAppServerArgs(), {
      cwd: options.cwd,
      env: {
        ...process.env,
        AGENT_ID: options.agentId,
        AGENT_CENTER_ATTACHED: '1',
      },
      stdio: ['pipe', 'pipe', 'inherit'],
      signal: options.signal,
    });
    this.child.once('error', (error) => this.failAll(error));
    this.child.once('exit', (code, signal) => {
      if (!this.stopped) this.failAll(new Error(`codex app-server exited with ${code ?? signal ?? 'unknown status'}`));
    });
    const lines = createInterface({ input: this.child.stdout! });
    lines.on('line', (line) => this.handleLine(line));
    options.signal?.addEventListener('abort', () => this.stop(), { once: true });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'hiq_agent_center', title: 'HiQ Agent Center', version: '0.0.5' },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: false,
      },
    });
    this.send({ method: 'initialized', params: {} });
    const readable = await this.request('thread/read', {
      threadId: this.options.sessionId,
      includeTurns: true,
    });
    assertCodexThreadCanResume(readable);
    const resumed = await this.request('thread/resume', {
      threadId: this.options.sessionId,
      cwd: this.options.cwd,
      approvalPolicy: 'never',
    });
    assertIdleCodexThread(resumed);
  }

  async deliver(event: DeliveryEvent): Promise<TurnCompletion> {
    const result = (await this.request('turn/start', {
      threadId: this.options.sessionId,
      cwd: this.options.cwd,
      approvalPolicy: 'never',
      input: [{ type: 'text', text: formatInboundTask(event) }],
    })) as { turn?: { id?: string } };
    const turnId = result.turn?.id;
    if (!turnId) throw new Error('codex app-server turn/start returned no turn id');
    const completed = this.completedTurns.get(turnId);
    if (completed) {
      this.completedTurns.delete(turnId);
      return completed;
    }
    return new Promise<TurnCompletion>((resolve) => this.turnWaiters.set(turnId, resolve));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.child.kill('SIGTERM');
    this.failAll(new Error('codex app-server stopped'));
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`codex app-server ${method} timed out`));
      }, 30_000);
      timer.unref();
      this.pending.set(String(id), { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  private send(message: Record<string, unknown>): void {
    this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcResponse;
    try {
      message = JSON.parse(line) as RpcResponse;
    } catch {
      this.options.log?.(`ignored non-JSON app-server output: ${line}`);
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message ?? `RPC error ${message.error.code ?? ''}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      // A headless listener only accepts the Agent Center MCP calls needed to update delivery state.
      // Other elicitations are canceled, and unknown server requests fail explicitly.
      const reply = headlessServerRequestReply(message);
      if (message.method === 'mcpServer/elicitation/request') {
        const action = (reply?.result as { action?: unknown } | undefined)?.action;
        this.options.log?.(`${String(action)} MCP elicitation in headless mode`);
      }
      if (reply) this.send(reply);
      return;
    }
    if (message.method === 'item/completed') {
      const params = message.params as { turnId?: unknown; item?: unknown } | undefined;
      const turnId = params?.turnId;
      const item = agentMessageItem(params?.item);
      if (typeof turnId === 'string' && item) {
        const messages = this.turnAgentMessages.get(turnId) ?? new Map<string, AgentMessageItem>();
        messages.set(item.id, item);
        this.turnAgentMessages.set(turnId, messages);
      }
      return;
    }
    if (message.method !== 'turn/completed') return;
    const turn = message.params?.turn as
      | { id?: string; status?: TurnCompletion['status']; error?: { message?: string }; items?: unknown[] }
      | undefined;
    if (!turn?.id || !turn.status) return;
    const completedItems = (turn.items ?? [])
      .map((item, index) => agentMessageItem(item, `turn-item-${index}`))
      .filter((item): item is AgentMessageItem => item !== undefined);
    const messages = this.turnAgentMessages.get(turn.id) ?? new Map<string, AgentMessageItem>();
    for (const item of completedItems) messages.set(item.id, item);
    this.turnAgentMessages.delete(turn.id);
    const finalText = finalAgentMessageText([...messages.values()]);
    const completion = { status: turn.status, finalText, error: turn.error?.message };
    const waiter = this.turnWaiters.get(turn.id);
    if (waiter) {
      this.turnWaiters.delete(turn.id);
      waiter(completion);
    } else {
      this.completedTurns.set(turn.id, completion);
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const resolve of this.turnWaiters.values()) {
      resolve({ status: 'failed', finalText: '', error: error.message });
    }
    this.turnWaiters.clear();
    this.turnAgentMessages.clear();
  }
}

export async function finalizeCodexDelivery(
  event: DeliveryEvent,
  completion: TurnCompletion,
  agentId: string,
): Promise<void> {
  const result = completedCodexResult(completion);
  if (event.type === 'message') {
    if (result) {
      await ackMessageFor(agentId, event.message.id).catch(() => undefined);
    }
    return;
  }

  const current = await getTask(agentId, event.task.id);
  if (isTaskStopped(current)) return;
  if (result) {
    await updateTaskFor(agentId, event.task.id, {
      state: 'TASK_STATE_COMPLETED',
      result,
    });
    return;
  }
  await updateTaskFor(agentId, event.task.id, {
    state: 'TASK_STATE_FAILED',
    message: completion.error ?? (completion.status === 'completed'
      ? 'Codex turn completed without an agent response.'
      : `Codex turn ended with status ${completion.status}.`),
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
  const log = (message: string): void => {
    process.stderr.write(`[agent-center-codex] ${message}\n`);
  };
  const client = new CodexAppServerClient({
    agentId,
    sessionId,
    cwd: arg('cwd') ?? process.cwd(),
    codexBin: process.env.CODEX_BIN ?? 'codex',
    signal: controller.signal,
    log,
  });
  process.stderr.write(`[agent-center-codex] Hub=${config.baseUrl} agent=${agentId} thread=${sessionId}\n`);
  await client.initialize();
  try {
    await runDeliveryStream(
      agentId,
      async (event) => finalizeCodexDelivery(event, await client.deliver(event), agentId),
      controller.signal,
      log,
    );
  } finally {
    client.stop();
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`[agent-center-codex] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
