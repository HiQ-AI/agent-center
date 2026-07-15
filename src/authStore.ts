// 本地凭据存储:~/.agent-center/auth.json。CLI `login` 写入,MCP server 读取。
// 只存 Hub 的 per-agent token + 归属;文件权限 0600(仅本人可读)。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';

export interface StoredAuth {
  token: string; // mikoshi per-agent token
  owner: string; // Cortex user_id
  agentId: string;
  agentName: string;
  hubUrl: string; // 运行时 Hub 基址
}

const DIR = join(homedir(), '.agent-center');
const FILE = join(DIR, 'auth.json');

export function loadAuth(): StoredAuth | null {
  try {
    if (!existsSync(FILE)) return null;
    return JSON.parse(readFileSync(FILE, 'utf8')) as StoredAuth;
  } catch {
    return null;
  }
}

export function saveAuth(a: StoredAuth): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(a, null, 2), { mode: 0o600 });
}

export function clearAuth(): void {
  try {
    rmSync(FILE);
  } catch {
    /* 已经没有就算了 */
  }
}

export const authFilePath = FILE;
