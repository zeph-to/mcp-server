import { readFileSync } from 'fs';
import { randomBytes } from 'crypto';
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

export const loadConfig = (): McpServerConfig => {
  const fileConfig = loadFileConfig();
  const apiKey = resolvedEnv('ZEPH_API_KEY') ?? fileConfig.apiKey;

  if (!apiKey) {
    throw new Error(
      'ZEPH_API_KEY not found. Run "npx @zeph-to/hook-sdk install" or set ZEPH_API_KEY env var.',
    );
  }

  return {
    apiKey,
    baseUrl: (resolvedEnv('ZEPH_BASE_URL') ?? fileConfig.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    hookId: resolvedEnv('ZEPH_HOOK_ID') ?? fileConfig.hookId,
    deviceId: resolvedEnv('ZEPH_DEVICE_ID') ?? fileConfig.deviceId,
    sessionId: resolvedEnv('ZEPH_SESSION_ID') ?? `sess_${randomBytes(12).toString('base64url')}`,
  };
};
