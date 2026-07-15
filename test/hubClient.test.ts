import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { isRegistered, register, sendMessage, streamInbox } from '../src/hubClient.js';

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
