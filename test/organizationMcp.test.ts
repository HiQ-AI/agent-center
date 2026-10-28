import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real MCP registration reports pending organization and whoami refreshes the verified binding', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-center-mcp-organization-'));
  let orgId: string | null = null;
  let bindingReadFails = false;
  const requests: string[] = [];
  const hub = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, 'Bearer fixture-mcp-owner');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/agents/discover') res.end(JSON.stringify({ agents: [] }));
    else if (bindingReadFails && req.url?.endsWith('/organization-binding')) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: 'fixture binding lookup unavailable' }));
    } else res.end(JSON.stringify({ agent: { id: 'mcp-fixture', name: 'Assistant', owner: 'alice', orgId } }));
  });
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const address = hub.address();
  assert.ok(address && typeof address !== 'string');
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', 'src/server.ts'],
    cwd: fileURLToPath(new URL('..', import.meta.url)), stderr: 'pipe',
    env: { HOME: home, PATH: process.env.PATH ?? '', AGENT_ID: 'mcp-fixture', AGENT_CENTER_TOKEN: 'fixture-mcp-owner', AGENT_CENTER_URL: `http://127.0.0.1:${address.port}`, AGENT_CENTER_WEB_BASE: 'https://cortex.example.invalid' },
  });
  const client = new Client({ name: 'organization-contract-fixture', version: '1.0.0' });
  let stderr = '';
  transport.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    const registered = await client.callTool({ name: 'agent_center_register', arguments: { name: 'Assistant' } });
    assert.notEqual(registered.isError, true);
    const text = JSON.stringify(registered.content);
    assert.match(text, /Organization enrollment: pending confirmation/);
    assert.match(text, /https:\/\/cortex.example.invalid\/chat\/agents\/mcp-fixture\/organization/);
    assert.doesNotMatch(text + stderr, /fixture-mcp-owner/);
    orgId = 'org-confirmed';
    const whoami = await client.callTool({ name: 'agent_center_whoami', arguments: {} });
    assert.match(JSON.stringify(whoami.content), /Organization enrollment: confirmed/);
    assert.match(JSON.stringify(whoami.content), /organization: org-confirmed/);
    bindingReadFails = true;
    const unavailable = await client.callTool({ name: 'agent_center_whoami', arguments: {} });
    assert.match(JSON.stringify(unavailable.content), /Organization enrollment: unverified/);
    assert.doesNotMatch(JSON.stringify(unavailable.content), /Organization enrollment: confirmed|organization: org-confirmed/);
    assert.equal(requests.filter((entry) => entry === 'POST /api/agents/register').length, 1);
    assert.ok(requests.includes('GET /api/agents/mcp-fixture/organization-binding'));
    assert.equal(requests.some((entry) => entry.startsWith('POST ') && entry.includes('organization-binding')), false);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => hub.close((err) => err ? reject(err) : resolve()));
    await rm(home, { recursive: true });
  }
});
