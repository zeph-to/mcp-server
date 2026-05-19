import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import { join } from 'path';

const DEFAULT_BASE_URL = 'https://api.zeph.to/v1';

export interface McpServerConfig {
  apiKey: string;
  baseUrl: string;
  hookId?: string;
  deviceId?: string;
  sessionId?: string;
}

interface FileConfig {
  apiKey?: string;
  baseUrl?: string;
  hookId?: string;
  deviceId?: string;
}

const resolvedEnv = (key: string): string | undefined => {
  const val = process.env[key];
  return val && !val.startsWith('${') ? val : undefined;
};

const loadFileConfig = (): FileConfig => {
  try {
    const configPath = join(process.env.HOME ?? '~', '.zeph', 'config.json');
    return JSON.parse(readFileSync(configPath, 'utf-8')) as FileConfig;
  } catch {
    return {};
  }
};

/** Detect Claude Code session ID from ~/.claude/projects/{projectHash}/{sessionId}/ */
const detectClaudeSessionId = (): string | undefined => {
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const projectHash = projectDir.replace(/\//g, '-');
    const sessionsDir = join(process.env.HOME ?? '~', '.claude', 'projects', projectHash);
    const entries = readdirSync(sessionsDir)
      .filter((name) => /^[0-9a-f]{8}-/.test(name))
      .map((name) => ({ name, mtime: statSync(join(sessionsDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return entries[0]?.name;
  } catch {
    return undefined;
  }
};

export const loadConfig = (): McpServerConfig => {
  const fileConfig = loadFileConfig();
  const apiKey = resolvedEnv('ZEPH_API_KEY') ?? fileConfig.apiKey;

  if (!apiKey) {
    throw new Error(
      'ZEPH_API_KEY not found. Run "npx @zeph-to/hook-sdk install" or set ZEPH_API_KEY env var.',
    );
  }

  const sessionId = resolvedEnv('ZEPH_SESSION_ID') ?? detectClaudeSessionId() ?? `sess_${randomBytes(12).toString('base64url')}`;

  // Write sessionId to tmp file so shell hooks (zeph-stop.sh) can read it
  try {
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const hash = execFileSync('cksum', { input: projectDir, encoding: 'utf-8' }).split(' ')[0];
    writeFileSync(`/tmp/zeph-session-${hash}`, sessionId);
  } catch { /* best-effort */ }

  return {
    apiKey,
    baseUrl: (resolvedEnv('ZEPH_BASE_URL') ?? fileConfig.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    hookId: resolvedEnv('ZEPH_HOOK_ID') ?? fileConfig.hookId,
    deviceId: resolvedEnv('ZEPH_DEVICE_ID') ?? fileConfig.deviceId,
    sessionId,
  };
};
