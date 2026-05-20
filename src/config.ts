import { readdirSync, readFileSync, statSync, mkdirSync, openSync, writeSync, closeSync, constants as fsConstants } from 'fs';
import { homedir } from 'os';
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
        const configPath = join(homedir(), '.zeph', 'config.json');
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
        const sessionsDir = join(homedir(), '.claude', 'projects', projectHash);

        let latest: { name: string; mtime: number } | undefined;
        for (const name of readdirSync(sessionsDir)) {
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(name)) continue;
            const fullPath = join(sessionsDir, name);
            const stat = statSync(fullPath);
            if (!stat.isDirectory()) continue;
            if (!latest || stat.mtimeMs > latest.mtime) {
                latest = { name, mtime: stat.mtimeMs };
            }
        }
        return latest?.name;
    } catch {
        return undefined;
    }
};

/**
 * Write the resolved session id to a per-user cache file so shell hooks
 * (e.g. plugin/hooks/zeph-stop.sh) can pick it up when their own transcript
 * scrape misses. The previous location was /tmp/zeph-session-<hash>, which
 * on multi-user machines exposed a symlink race — predictable filename,
 * world-writable directory. Living under ~/.cache (or $XDG_CACHE_HOME)
 * removes that — only the owning user can write there. The file is also
 * opened with O_NOFOLLOW so a pre-existing symlink can never redirect us
 * to /etc/passwd or similar.
 */
const writeSessionCache = (sessionId: string, projectDir: string): void => {
    try {
        const hash = execFileSync('cksum', { input: projectDir, encoding: 'utf-8' }).split(' ')[0];
        const cacheDir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'zeph');
        mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
        const cachePath = join(cacheDir, `session-${hash}`);
        const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
        const fd = openSync(cachePath, flags, 0o600);
        try {
            writeSync(fd, sessionId);
        } finally {
            closeSync(fd);
        }
    } catch {
        /* best-effort — hook stop script also extracts session id from
         * the transcript path, so failing here is non-fatal. */
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
    const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    writeSessionCache(sessionId, projectDir);

    return {
        apiKey,
        baseUrl: (resolvedEnv('ZEPH_BASE_URL') ?? fileConfig.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
        hookId: resolvedEnv('ZEPH_HOOK_ID') ?? fileConfig.hookId,
        deviceId: resolvedEnv('ZEPH_DEVICE_ID') ?? fileConfig.deviceId,
        sessionId,
    };
};
