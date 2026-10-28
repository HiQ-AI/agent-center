import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
let home: string;
let base: string;
let status = 200;
let orgId: string | null = null;
const requests: string[] = [];
const hub = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  assert.equal(req.headers.authorization, 'Bearer fixture-owner-token');
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(status === 200 ? { agent: { id: 'existing-agent', orgId } } : { error: 'not your agent' }));
});

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-center-organization-test-'));
  await new Promise<void>((resolve) => hub.listen(0, '127.0.0.1', resolve));
  const address = hub.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => hub.close((err) => err ? reject(err) : resolve()));
  await rm(home, { recursive: true });
});

function cli(args: string[]) {
  return run(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: root, timeout: 10_000,
    env: { ...process.env, HOME: home, AGENT_CENTER_URL: base, AGENT_CENTER_TOKEN: 'fixture-owner-token', AGENT_CENTER_WEB_BASE: 'https://cortex.example.invalid' },
  });
}

test('organization command reads an existing identity without registering or binding', async () => {
  const pending = await cli(['organization', '--agent-id', 'existing-agent']);
  assert.match(pending.stdout, /pending confirmation/);
  assert.match(pending.stdout, /https:\/\/cortex.example.invalid\/chat\/agents\/existing-agent\/organization/);
  assert.doesNotMatch(pending.stdout + pending.stderr, /fixture-owner-token/);
  orgId = 'org-confirmed';
  const confirmed = await cli(['organization', '--agent-id', 'existing-agent']);
  assert.match(confirmed.stdout, /organization: org-confirmed/);
  assert.doesNotMatch(confirmed.stdout, /pending confirmation/);
  assert.deepEqual(requests, [
    'GET /api/agents/existing-agent/organization-binding',
    'GET /api/agents/existing-agent/organization-binding',
  ]);
});

test('missing target and unauthorized target exit without a false success', async () => {
  const count = requests.length;
  await assert.rejects(cli(['organization']), (error: unknown) => {
    const failure = error as { code: number; stderr: string };
    assert.equal(failure.code, 2);
    assert.match(failure.stderr, /requires --agent-id/);
    return true;
  });
  assert.equal(requests.length, count);
  status = 403;
  await assert.rejects(cli(['organization', '--agent-id', 'another-agent']), (error: unknown) => {
    const failure = error as { code: number; stderr: string; stdout: string };
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /could not be verified/);
    assert.doesNotMatch(failure.stdout, /enrollment: confirmed/);
    return true;
  });
});
