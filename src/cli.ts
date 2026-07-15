#!/usr/bin/env node
/**
 * `agent-center` CLI — the onboarding entry point for the Agent Center.
 *   agent-center login    device authorization (OAuth device flow): opens the approval page →
 *                         you confirm in the browser → the token is stored locally
 *   agent-center whoami   show the current connected identity
 *   agent-center logout   clear the local credential
 * After login the MCP server (agent-center-mcp) reads ~/.agent-center/auth.json automatically,
 * so the agent gains its interconnection tools.
 */
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { loadAuth, saveAuth, clearAuth, authFilePath } from './authStore.js';
import { ensureIdentity } from './hubClient.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    /* can't open — the user clicks it manually; the URL is already printed */
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function login(): Promise<void> {
  const agentId = arg('id') ?? config.agentId;
  const agentName = arg('name') ?? config.agentName;
  const deck = config.deckBase;

  const start = await fetch(`${deck}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, agent_name: agentName }),
  });
  if (!start.ok) {
    console.error(`Failed to start authorization: ${start.status} ${await start.text()}`);
    process.exit(1);
  }
  const { device_code, user_code, verification_uri_complete, verification_uri, interval, expires_in } =
    (await start.json()) as {
      device_code: string;
      user_code: string;
      verification_uri_complete?: string;
      verification_uri: string;
      interval?: number;
      expires_in?: number;
    };

  console.log('\n  Approve in your browser (with your Cortex account):');
  console.log(`\n    ${verification_uri_complete ?? verification_uri}`);
  console.log(`\n  Code: ${user_code}\n`);
  openBrowser(verification_uri_complete ?? verification_uri);

  const deadline = Date.now() + (expires_in ?? 600) * 1000;
  const pollMs = Math.max(2, interval ?? 5) * 1000;
  process.stdout.write('  Waiting for approval');
  // Fixed-step deadline loop (does not depend on Date.now precision — just waits).
  while (Date.now() < deadline) {
    await sleep(pollMs);
    process.stdout.write('.');
    const res = await fetch(`${deck}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code }),
    });
    if (res.status === 428) continue; // authorization_pending
    if (res.ok) {
      const { access_token, owner } = (await res.json()) as { access_token: string; owner: string };
      saveAuth({ token: access_token, owner, agentId, agentName, hubUrl: config.baseUrl });
      await ensureIdentity({ id: agentId, kind: config.agentKind, name: agentName }, access_token);
      console.log(`\n\n  ✅ Connected and ready. Identity owner=${owner}; credential stored at ${authFilePath}`);
      console.log('  discover/send/inbox work immediately; publish capabilities with agent_center_register when wanted.\n');
      return;
    }
    console.error(`\n  Authorization failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.error('\n  Authorization timed out. Run `agent-center login` again.');
  process.exit(1);
}

function whoami(): void {
  const a = loadAuth();
  if (!a) {
    console.log('Not logged in. Run `agent-center login` to connect.');
    return;
  }
  console.log(`Connected: ${a.agentName} (id=${a.agentId}, owner=${a.owner})\nHub=${a.hubUrl}\nCredential: ${authFilePath}`);
}

function logout(): void {
  clearAuth();
  console.log('Local credential cleared.');
}

const cmd = process.argv[2];
if (cmd === 'login') void login();
else if (cmd === 'whoami') whoami();
else if (cmd === 'logout') logout();
else {
  console.log('Usage: agent-center <login|whoami|logout>');
  console.log('  login   device authorization to join the Agent Center (browser confirm)');
  console.log('  whoami  show the current connected identity');
  console.log('  logout  clear the local credential');
}
