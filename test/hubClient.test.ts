import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { isRegistered, register, sendMessage } from '../src/hubClient.js';

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
