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
    /** Last path segment of the project directory — prefixed onto push titles. */
    projectName: string;
}

const PROJECT_DIR_ENV_KEYS = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR'] as const;

/** The project directory the agent runs in, across supported agents. */
const detectProjectDir = (): string => {
    for (const key of PROJECT_DIR_ENV_KEYS) {
        const val = process.env[key];
        if (val) return val;
    }
    return process.cwd();
};

/** Last path segment of a directory: "/Users/me/code/zeph" -> "zeph". */
const projectNameFromDir = (dir: string): string =>
    dir.split('/').filter(Boolean).pop() ?? 'project';

/**
 * Prefix a push title with the project name so the device feed stays
 * scannable — "zeph · Build finished" instead of a bare "Build finished".
 * Idempotent: a title already carrying the project segment is returned
 * unchanged (guards against double-prefixing on retries).
 */
export const formatPushTitle = (projectName: string, title: string): string => {
    const prefix = `${projectName} · `;
    return title.startsWith(prefix) ? title : prefix + title;
};

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

const SESSION_UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/**
 * Detect the Claude Code session ID for `projectDir`. Claude Code writes
 * one transcript per session at `~/.claude/projects/<projectHash>/<uuid>.jsonl`
 * where the hash is the project path with `/` replaced by `-`. We pick the
 * most recently modified transcript — that's the live session.
 */
const detectClaudeSessionId = (projectDir: string): string | undefined => {
    try {
        const projectHash = projectDir.replace(/\//g, '-');
        const sessionsDir = join(homedir(), '.claude', 'projects', projectHash);

        let latest: { name: string; mtime: number } | undefined;
        for (const entry of readdirSync(sessionsDir)) {
            const match = SESSION_UUID_RE.exec(entry);
            if (!match) continue;
            const stat = statSync(join(sessionsDir, entry));
            if (!stat.isFile()) continue;
            if (!latest || stat.mtimeMs > latest.mtime) {
                latest = { name: match[1], mtime: stat.mtimeMs };
            }
        }
        return latest?.name;
    } catch {
        return undefined;
    }
};

/**
 * Truthy-env helper — accepts "1", "true", "yes", "on" (case-insensitive).
 */
const envIsTrue = (key: string): boolean => {
    const v = process.env[key];
    if (!v) return false;
    return /^(1|true|yes|on)$/i.test(v.trim());
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
 *
 * Users can opt out entirely by setting ZEPH_DISABLE_SESSION_CACHE=1.
 * Useful for:
 *   - Read-only filesystems (some container runtimes)
 *   - CI runners where ~/.cache isn't persisted anyway, so the write is
 *     pure overhead
 *   - Sandboxed environments where extra filesystem writes trigger audit
 *     noise
 * The shell hook still works without the cache — it primarily extracts
 * the session id from the transcript_path UUID; the cache is just a
 * fallback for older Claude Code versions.
 */
const writeSessionCache = (sessionId: string, projectDir: string): void => {
    if (envIsTrue('ZEPH_DISABLE_SESSION_CACHE')) return;
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
            'ZEPH_API_KEY not found. Run "npx @zeph-to/cli install" or set ZEPH_API_KEY env var.',
        );
    }

    const projectDir = detectProjectDir();
    const sessionId = resolvedEnv('ZEPH_SESSION_ID') ?? detectClaudeSessionId(projectDir) ?? `sess_${randomBytes(12).toString('base64url')}`;
    writeSessionCache(sessionId, projectDir);

    return {
        apiKey,
        baseUrl: (resolvedEnv('ZEPH_BASE_URL') ?? fileConfig.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
        hookId: resolvedEnv('ZEPH_HOOK_ID') ?? fileConfig.hookId,
        deviceId: resolvedEnv('ZEPH_DEVICE_ID') ?? fileConfig.deviceId,
        sessionId,
        projectName: projectNameFromDir(projectDir),
    };
};
