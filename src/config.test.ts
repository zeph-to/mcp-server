import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each test scopes HOME / cwd / env to a freshly-created temp dir so the
// real ~/.zeph and ~/.cache/zeph never get touched. We snapshot the
// originals key-by-key (not by reassigning process.env, which detaches
// the JS object from the native getenv() Node uses for os.homedir).

const ZEPH_ENV_KEYS = [
    'HOME', 'ZEPH_API_KEY', 'ZEPH_HOOK_ID', 'ZEPH_BASE_URL',
    'ZEPH_DEVICE_ID', 'ZEPH_SESSION_ID', 'ZEPH_DISABLE_SESSION_CACHE',
    'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'CLAUDE_PROJECT_DIR',
    'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR',
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of ZEPH_ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'mcp-config-test-'));
    for (const key of ZEPH_ENV_KEYS) delete process.env[key];
    process.env.HOME = TMP;
    vi.resetModules();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    for (const key of ZEPH_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});

const writeFileConfig = (data: Record<string, unknown>): void => {
    const dir = join(TMP, '.zeph');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify(data));
};

describe('loadConfig', () => {
    it('throws when no api key is anywhere', async () => {
        const { loadConfig } = await import('./config.js');
        expect(() => loadConfig()).toThrow(/ZEPH_API_KEY not found/);
    });

    it('reads api key from env', async () => {
        process.env.ZEPH_API_KEY = 'ak_from_env';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().apiKey).toBe('ak_from_env');
    });

    it('falls back to ~/.zeph/config.json when env is missing', async () => {
        writeFileConfig({ apiKey: 'ak_from_file', hookId: 'hook_file' });
        const { loadConfig } = await import('./config.js');
        const cfg = loadConfig();
        expect(cfg.apiKey).toBe('ak_from_file');
        expect(cfg.hookId).toBe('hook_file');
    });

    it('env takes precedence over file', async () => {
        writeFileConfig({ apiKey: 'ak_from_file' });
        process.env.ZEPH_API_KEY = 'ak_from_env';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().apiKey).toBe('ak_from_env');
    });

    it('treats unresolved ${VAR} placeholder as unset (env layer)', async () => {
        // Catches a real bug: some IDEs spawn MCP with env: { ZEPH_API_KEY: "${ZEPH_API_KEY}" }
        // and if the outer shell doesn't have the var, the literal "${...}"
        // string would otherwise be treated as the key.
        process.env.ZEPH_API_KEY = '${ZEPH_API_KEY}';
        writeFileConfig({ apiKey: 'ak_from_file' });
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().apiKey).toBe('ak_from_file');
    });

    it('strips trailing slash from baseUrl', async () => {
        process.env.ZEPH_API_KEY = 'ak';
        process.env.ZEPH_BASE_URL = 'https://api.example.com/v1/';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().baseUrl).toBe('https://api.example.com/v1');
    });

    it('defaults baseUrl to prod when nothing is provided', async () => {
        process.env.ZEPH_API_KEY = 'ak';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().baseUrl).toBe('https://api.zeph.to/v1');
    });

    it('generates a sess_ prefix sessionId when nothing is provided', async () => {
        process.env.ZEPH_API_KEY = 'ak';
        const { loadConfig } = await import('./config.js');
        const cfg = loadConfig();
        expect(cfg.sessionId).toMatch(/^sess_/);
    });

    it('respects ZEPH_SESSION_ID env override', async () => {
        process.env.ZEPH_API_KEY = 'ak';
        process.env.ZEPH_SESSION_ID = 'my-custom-session-id';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().sessionId).toBe('my-custom-session-id');
    });

    it('derives projectName from CLAUDE_PROJECT_DIR basename', async () => {
        process.env.ZEPH_API_KEY = 'ak';
        process.env.CLAUDE_PROJECT_DIR = '/Users/me/code/my-project';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().projectName).toBe('my-project');
    });

    it('uses CURSOR_PROJECT_DIR when CLAUDE_PROJECT_DIR is absent', async () => {
        process.env.ZEPH_API_KEY = 'ak';
        process.env.CURSOR_PROJECT_DIR = '/work/cursor-proj';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().projectName).toBe('cursor-proj');
    });

    it('CLAUDE_PROJECT_DIR takes precedence over CURSOR_PROJECT_DIR', async () => {
        process.env.ZEPH_API_KEY = 'ak';
        process.env.CLAUDE_PROJECT_DIR = '/a/claude-proj';
        process.env.CURSOR_PROJECT_DIR = '/b/cursor-proj';
        const { loadConfig } = await import('./config.js');
        expect(loadConfig().projectName).toBe('claude-proj');
    });

    it('falls back to cwd basename when no project env is set', async () => {
        process.env.ZEPH_API_KEY = 'ak';
        const { loadConfig } = await import('./config.js');
        const expected = process.cwd().split('/').filter(Boolean).pop();
        expect(loadConfig().projectName).toBe(expected);
    });
});

describe('formatPushTitle', () => {
    it('prefixes the project name with a separator', async () => {
        const { formatPushTitle } = await import('./config.js');
        expect(formatPushTitle('zeph', 'Build finished')).toBe('zeph · Build finished');
    });

    it('is idempotent — does not double-prefix the same project', async () => {
        const { formatPushTitle } = await import('./config.js');
        const once = formatPushTitle('zeph', 'Build finished');
        expect(formatPushTitle('zeph', once)).toBe('zeph · Build finished');
    });

    it('still prefixes when a different project segment is already present', async () => {
        const { formatPushTitle } = await import('./config.js');
        expect(formatPushTitle('web', 'api · Deploy done')).toBe('web · api · Deploy done');
    });
});

describe('writeSessionCache (via loadConfig)', () => {
    const sessionFiles = (): string[] => {
        const dir = join(TMP, '.cache', 'zeph');
        if (!existsSync(dir)) return [];
        return require('node:fs').readdirSync(dir).filter((f: string) => f.startsWith('session-'));
    };

    it('writes the session id under $HOME/.cache/zeph/ by default', async () => {
        process.env.ZEPH_API_KEY = 'ak';
        process.env.CLAUDE_PROJECT_DIR = '/some/test/project';
        const { loadConfig } = await import('./config.js');
        loadConfig();
        const files = sessionFiles();
        expect(files.length).toBe(1);
    });

    it('writes the session cache when only CURSOR_PROJECT_DIR is set', async () => {
        process.env.ZEPH_API_KEY = 'ak';
        process.env.CURSOR_PROJECT_DIR = '/work/cursor-only';
        const { loadConfig } = await import('./config.js');
        loadConfig();
        expect(sessionFiles().length).toBe(1);
    });

    it('honors $XDG_CACHE_HOME when set', async () => {
        const xdg = join(TMP, 'custom-cache');
        process.env.ZEPH_API_KEY = 'ak';
        process.env.XDG_CACHE_HOME = xdg;
        process.env.CLAUDE_PROJECT_DIR = '/another/project';
        const { loadConfig } = await import('./config.js');
        loadConfig();
        // Default ~/.cache should not have been used
        expect(existsSync(join(TMP, '.cache', 'zeph'))).toBe(false);
        expect(existsSync(join(xdg, 'zeph'))).toBe(true);
    });

    it('opt-out via ZEPH_DISABLE_SESSION_CACHE=1', async () => {
        process.env.ZEPH_API_KEY = 'ak';
        process.env.ZEPH_DISABLE_SESSION_CACHE = '1';
        process.env.CLAUDE_PROJECT_DIR = '/opted/out';
        const { loadConfig } = await import('./config.js');
        loadConfig();
        expect(sessionFiles().length).toBe(0);
    });

    it('opt-out also accepts true / yes / on (case-insensitive, trimmed)', async () => {
        for (const val of ['true', 'TRUE', 'yes', 'On', '  true  ']) {
            process.env.ZEPH_API_KEY = 'ak';
            process.env.ZEPH_DISABLE_SESSION_CACHE = val;
            process.env.CLAUDE_PROJECT_DIR = '/opted/out';
            // Re-import within the loop for env-capture freshness
            vi.resetModules();
            const { loadConfig } = await import('./config.js');
            loadConfig();
            expect(sessionFiles().length).toBe(0);
            delete process.env.ZEPH_DISABLE_SESSION_CACHE;
        }
    });
});

describe('detectClaudeSessionId (via loadConfig)', () => {
    it('detects the session UUID from a ~/.claude/projects/<hash>/<uuid>.jsonl file', async () => {
        const projectDir = '/some/test/project';
        const uuid = '12345678-1234-1234-1234-1234567890ab';
        process.env.ZEPH_API_KEY = 'ak';
        process.env.CLAUDE_PROJECT_DIR = projectDir;

        // Hash is the project path with '/' replaced by '-' (leading dash included).
        const projectHash = projectDir.replace(/\//g, '-');
        const sessionsDir = join(TMP, '.claude', 'projects', projectHash);
        mkdirSync(sessionsDir, { recursive: true });
        writeFileSync(join(sessionsDir, `${uuid}.jsonl`), '{}');

        const { loadConfig } = await import('./config.js');
        expect(loadConfig().sessionId).toBe(uuid);
    });
});
