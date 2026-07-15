#!/usr/bin/env node
/**
 * `agent-center` CLI —— 接入 Agent Center 的 onboarding 入口。
 *   agent-center login   设备授权(OAuth device flow):打开授权页 → 你在浏览器确认 → 本地存 token
 *   agent-center whoami   看当前接入身份
 *   agent-center logout   清除本地凭据
 * login 之后 MCP server(agent-center-mcp)自动读 ~/.agent-center/auth.json,agent 即具备互联工具。
 */
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { loadAuth, saveAuth, clearAuth, authFilePath } from './authStore.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref();
  } catch {
    /* 打不开就靠用户手点,URL 已打印 */
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
    console.error(`发起授权失败:${start.status} ${await start.text()}`);
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

  console.log('\n  在浏览器里确认授权(以你的 Cortex 账号):');
  console.log(`\n    ${verification_uri_complete ?? verification_uri}`);
  console.log(`\n  授权码:${user_code}\n`);
  openBrowser(verification_uri_complete ?? verification_uri);

  const deadline = Date.now() + (expires_in ?? 600) * 1000;
  const pollMs = Math.max(2, interval ?? 5) * 1000;
  process.stdout.write('  等待授权');
  // 用固定步进的 deadline 循环(不依赖 Date.now 的精度,纯等待)。
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
      console.log(`\n\n  ✅ 已接入。身份 owner=${owner},凭据存于 ${authFilePath}`);
      console.log('  现在 agent-center-mcp 会自动带上它 —— agent 已具备互联能力。\n');
      return;
    }
    console.error(`\n  授权失败:${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.error('\n  授权超时,请重试 agent-center login。');
  process.exit(1);
}

function whoami(): void {
  const a = loadAuth();
  if (!a) {
    console.log('未登录。运行 `agent-center login` 接入。');
    return;
  }
  console.log(`已接入:${a.agentName} (id=${a.agentId}, owner=${a.owner})\nHub=${a.hubUrl}\n凭据:${authFilePath}`);
}

function logout(): void {
  clearAuth();
  console.log('已清除本地凭据。');
}

const cmd = process.argv[2];
if (cmd === 'login') void login();
else if (cmd === 'whoami') whoami();
else if (cmd === 'logout') logout();
else {
  console.log('用法:agent-center <login|whoami|logout>');
  console.log('  login   设备授权接入 Agent Center(浏览器确认)');
  console.log('  whoami  查看当前接入身份');
  console.log('  logout  清除本地凭据');
}
