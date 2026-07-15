import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { ensureIdentity } from '../src/hubClient.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('ensureIdentity provisions a private messaging identity with the supplied token', async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init };
    return new Response(JSON.stringify({ agent: { id: 'codex' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const agent = await ensureIdentity(
    { id: 'codex', kind: 'personal', name: 'Cortex Codex' },
    'mkt_test',
  );

  assert.deepEqual(agent, { id: 'codex' });
  assert.equal(request?.url, `${config.baseUrl}/api/agents/ensure`);
  assert.equal(request?.init?.method, 'POST');
  assert.equal((request?.init?.headers as Record<string, string>).Authorization, 'Bearer mkt_test');
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    id: 'codex',
    kind: 'personal',
    name: 'Cortex Codex',
  });
});
