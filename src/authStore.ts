// Local credential store: ~/.agent-center/auth.json. Written by CLI `login`, read by the MCP server.
// Holds only the owner-level Hub credential; session agent identity is never persisted here.
// File mode 0600 (owner-readable only).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';

export interface StoredAuth {
  token: string; // Hub credential scoped to one owner
  owner: string; // Cortex user_id
  hubUrl: string; // runtime Hub base
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
    /* already gone — fine */
  }
}

export const authFilePath = FILE;
