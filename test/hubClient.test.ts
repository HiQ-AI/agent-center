import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  delegateTask,
  isRegistered,
  register,
  sendMessage,
  streamEvents,
  streamInbox,
  waitForTask,
} from '../src/hubClient.js';

const originalFetch = globalThis.fetch;
const originalToken = config.token;

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.token = originalToken;
});

test('send requires this MCP session to register first', async () => {
  let called = false;
  config.token = 'mkt_test';
  globalThis.fetch = async () => {
    called = true;
    throw new Error('unexpected fetch');
  };

  await assert.rejects(
    sendMessage({ to: 'other', body: 'hello' }),
    /this session is not registered/,
  );
  assert.equal(called, false);
});

test('register creates the current session with passive defaults', async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  config.token = 'mkt_test';
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify({ agent: { id: config.agentId } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const agent = await register({ name: 'Cortex Codex' });

  assert.deepEqual(agent, { id: config.agentId });
  assert.equal(isRegistered(), true);
  assert.equal(request?.url, `${config.baseUrl}/api/agents/register`);
  assert.equal(request?.init?.method, 'POST');
  assert.equal((request?.init?.headers as Record<string, string>).Authorization, 'Bearer mkt_test');
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    id: config.agentId,
    kind: config.agentKind,
    name: 'Cortex Codex',
    capabilities: [],
    visibility: 'org',
    discoverable: false,
    acceptsDelegation: false,
  });
});

test('streamInbox parses durable SSE message events across chunk boundaries', async () => {
  config.token = 'mkt_test';
  const encoder = new TextEncoder();
  const payload = {
    id: 'msg_1',
    fromAgent: 'agent-a',
    toAgent: 'agent-b',
    capability: null,
    body: 'hello',
    replyTo: null,
    createdAt: '2026-07-15T00:00:00.000Z',
  };
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(': connected\n\nid: msg_1\nevent: mes'));
        controller.enqueue(encoder.encode(`sage\ndata: ${JSON.stringify(payload)}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  const received = [];
  for await (const message of streamInbox('agent-b')) received.push(message);

  assert.deepEqual(received, [payload]);
  assert.equal(request?.url, `${config.baseUrl}/api/agents/agent-b/events`);
  assert.equal((request?.init?.headers as Record<string, string>).Accept, 'text/event-stream');
  assert.equal((request?.init?.headers as Record<string, string>).Authorization, 'Bearer mkt_test');
});

test('streamEvents preserves the message/task event discriminator', async () => {
  config.token = 'mkt_test';
  const encoder = new TextEncoder();
  const task = {
    id: 'task-1',
    contextId: 'context-1',
    status: { state: 'TASK_STATE_SUBMITTED', timestamp: '2026-07-15T00:00:00.000Z' },
    history: [],
  };
  globalThis.fetch = async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: task\ndata: ${JSON.stringify(task)}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  const received = [];
  for await (const event of streamEvents('agent-b')) received.push(event);
  assert.deepEqual(received, [{ type: 'task', task }]);
});

test('delegateTask sends A2A v1 headers and registered source identity', async () => {
  config.token = 'mkt_test';
  let request: { input: string | URL | Request; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    request = { input, init };
    return Response.json({
      task: {
        id: 'task-1',
        contextId: 'context-1',
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: '2026-07-15T00:00:00.000Z' },
      },
    });
  };

  const task = await delegateTask({ to: 'agent-b', body: 'Review this', capability: 'review' });
  assert.equal(task.id, 'task-1');
  const headers = request?.init?.headers as Record<string, string>;
  assert.equal(headers['Content-Type'], 'application/a2a+json');
  assert.equal(headers.Accept, 'application/a2a+json');
  assert.equal(headers['A2A-Version'], '1.0');
  assert.equal(headers['A2A-Extensions'], 'https://agent-center.hiq.earth/extensions/routing/v1');
  const body = JSON.parse(String(request?.init?.body)) as {
    metadata: { agentCenter: { sourceAgentId: string; requestedCapability: string } };
  };
  assert.equal(body.metadata.agentCenter.sourceAgentId, config.agentId);
  assert.equal(body.metadata.agentCenter.requestedCapability, 'review');
});

test('waitForTask hydrates a terminal SSE projection from the Task snapshot', async () => {
  config.token = 'mkt_test';
  const encoder = new TextEncoder();
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith(':subscribe')) {
      const projection = {
        id: 'task-terminal',
        contextId: 'context-1',
        status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-07-16T00:00:00.000Z' },
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ task: projection })}\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return Response.json({
      id: 'task-terminal',
      contextId: 'context-1',
      status: { state: 'TASK_STATE_COMPLETED', timestamp: '2026-07-16T00:00:00.000Z' },
      artifacts: [{ artifactId: 'result', parts: [{ text: 'full result' }] }],
    });
  };

  const task = await waitForTask('agent-b', 'task-terminal', 1);
  assert.equal(task.artifacts?.[0]?.parts[0]?.text, 'full result');
  assert.equal(requests.length, 2);
});
