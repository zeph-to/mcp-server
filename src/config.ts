import { readdirSync, readFileSync, statSync, mkdirSync, openSync, writeSync, closeSync, constants as fsConstants } from 'fs';
import { homedir, hostname } from 'os';
import { randomBytes, createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { join } from 'path';

const DEFAULT_BASE_URL = 'https://api.zeph.to/v1';

export interface McpServerConfig {
    apiKey: string;
    baseUrl: string;
    /** WebSocket endpoint for the hook-response fast path (§S3). Optional —
     *  without it (or without a WebSocket global) waits are poll-only. */
    wsUrl?: string;
    hookId?: string;
    deviceId?: string;
    sessionId?: string;
    /** Stable agent-session key parts so hook pushes join the session chat:
     *  the listener's per-host device id (mirrors cli computeListenerDeviceId)
     *  + the tmux session name. The Claude sessionId above rotates on
     *  compact/resume; these don't. */
    agentDeviceId?: string;
    agentSessionName?: string;
    /** Last path segment of the project directory — prefixed onto push titles. */
    projectName: string;
}

const PROJECT_DIR_ENV_KEYS = ['CLAUDE_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'WINDSURF_PROJECT_DIR'] as const;

/** The project directory the agent runs in, across supported agents. */
/**
 * The key every per-project zeph file is named by. Shelling out to `cksum`
 * (rather than a pure-JS CRC) is what guarantees it matches the files the bash
 * hooks have already written — they key off `printf '%s' "$dir" | cksum`. Null
 * when `cksum` is unavailable, which means no per-project file can be resolved.
 */
export const projectHash = (dir: string): string | null => {
    try {
        return execFileSync('cksum', { input: dir, encoding: 'utf-8' }).split(' ')[0] || null;
    } catch {
        return null;
    }
};

export const detectProjectDir = (): string => {
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
    wsUrl?: string;
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
        const hash = projectHash(projectDir);
        if (!hash) return;
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
    // Claude Code names the running session outright; take it over the
    // transcript scan, which picks the newest file in the project directory and
    // so returns a sibling agent's id whenever two run in one project — the
    // server then threads this session's pushes into the neighbour's chat.
    const sessionId =
        resolvedEnv('ZEPH_SESSION_ID') ??
        resolvedEnv('CLAUDE_CODE_SESSION_ID') ??
        detectClaudeSessionId(projectDir) ??
        `sess_${randomBytes(12).toString('base64url')}`;
    writeSessionCache(sessionId, projectDir);

    return {
        apiKey,
        baseUrl: (resolvedEnv('ZEPH_BASE_URL') ?? fileConfig.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
        // Config first, environment second — the inverse of what this used to
        // be. `ZEPH_WS_URL` sat ABOVE ~/.zeph/config.json, so an `export` in a
        // shell profile silently outranked the file with nothing anywhere to
        // say it had. It still answers when the file has nothing, so a
        // self-hosted machine does not quietly lose its WebSocket fast path.
        wsUrl: fileConfig.wsUrl ?? legacyWsEnv(),
        hookId: resolvedEnv('ZEPH_HOOK_ID') ?? fileConfig.hookId,
        deviceId: resolvedEnv('ZEPH_DEVICE_ID') ?? fileConfig.deviceId,
        sessionId,
        agentDeviceId: listenerDeviceId(),
        agentSessionName: detectTmuxSessionName(),
        projectName: projectNameFromDir(projectDir),
    };
};

const LISTENER_ID_FILE = join(homedir(), '.zeph', 'listener-device-id');

const hashListenerId = (seed: string): string =>
    `dev_listener_${createHash('sha256').update(seed).digest('hex').slice(0, 8)}`;

/** Platform machine id (macOS IOPlatformUUID / Linux machine-id), or null.
 *  Mirrors cli `readMachineId` so the hash below matches the listener's id. */
const readMachineId = (): string | null => {
    try {
        if (process.platform === 'darwin') {
            const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf-8' });
            const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
            if (m) return m[1];
        }
        if (process.platform === 'linux') {
            for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
                try {
                    const v = readFileSync(p, 'utf-8').trim();
                    if (v) return v;
                } catch { /* try next path */ }
            }
        }
    } catch { /* no machine id readable — fall through */ }
    return null;
};

/** Listener device id — MUST match cli `computeListenerDeviceId` so `zeph_ask`
 *  hooks land under the same agent-session key as the listener's
 *  agent.command/state pushes (otherwise they reach the feed but never thread
 *  into the agent chat). cli hashes the platform machine id first and falls
 *  back to a hostname hash pinned in a sticky file; mirror that order, reading
 *  (never writing) the file so both processes resolve the same id. */
export const listenerDeviceId = (): string => {
    const machineId = readMachineId();
    if (machineId) return hashListenerId(machineId);
    try {
        const saved = readFileSync(LISTENER_ID_FILE, 'utf-8').trim();
        if (/^dev_listener_[0-9a-f]{8}$/.test(saved)) return saved;
    } catch { /* no sticky file — fall back to hostname */ }
    return hashListenerId(hostname());
};

/** How far up the process tree the pane search walks. A pane's agent spawns
 *  this server as a child or grandchild; more hops than this means the match
 *  would be some unrelated ancestor, not the pane running the agent. */
const PANE_ANCESTRY_HOPS = 8;

/** `ps` for one pid's parent, or null at the top of the tree (or on error). */
const parentPid = (pid: number, run: CommandRunner): number | null => {
    const out = run('ps', ['-o', 'ppid=', '-p', String(pid)]);
    const parsed = Number(out?.trim());
    return Number.isInteger(parsed) && parsed > 1 ? parsed : null;
};

/** Shells out; returns null instead of throwing so every caller reads as one
 *  expression. */
export type CommandRunner = (cmd: string, args: string[]) => string | null;

const liveRunner: CommandRunner = (cmd, args) => {
    try {
        return execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
        return null;
    }
};

/**
 * The tmux session whose pane is an ancestor of this process, for an agent that
 * spawns its MCP servers with a sanitized environment.
 *
 * Codex CLI does exactly that — measured 2026-09-14, codex-cli 0.154.0: the
 * `zeph mcp` child it starts inside a tmux pane has only HOME/PATH/LANG/TERM/
 * USER/SHELL/TMPDIR/LOGNAME, no TMUX, and `shell_environment_policy.inherit=all`
 * does not change it (that policy governs its shell tool, not MCP spawns). The
 * env check alone therefore reported "not in tmux" for a session plainly running
 * in one, the push lost its session key, and the phone opened the plain push
 * screen instead of the agent chat with its live terminal.
 *
 * The pane's own pid IS in the tree, so ask tmux which pids own panes and walk
 * up from here until one matches.
 */
const tmuxSessionByPaneAncestry = (run: CommandRunner): string | undefined => {
    const panes = run('tmux', ['list-panes', '-a', '-F', '#{pane_pid} #S']);
    if (!panes) return undefined;
    const sessionByPanePid = new Map<number, string>();
    for (const line of panes.split('\n')) {
        const [pid, ...rest] = line.trim().split(' ');
        const name = rest.join(' ').trim();
        if (pid && name) sessionByPanePid.set(Number(pid), name);
    }

    let pid: number | null = process.pid;
    for (let hop = 0; hop < PANE_ANCESTRY_HOPS && pid !== null; hop += 1) {
        const name = sessionByPanePid.get(pid);
        if (name) return name;
        pid = parentPid(pid, run);
    }
    return undefined;
};

/** The tmux session name the agent runs in (`zeph-<project>`) — stable half of
 *  the session key. Undefined outside tmux; the hook then stays feed-only. */
export const detectTmuxSessionName = (run: CommandRunner = liveRunner): string | undefined => {
    if (process.env.TMUX) {
        const name = run('tmux', ['display-message', '-p', '#S'])?.trim();
        if (name) return name;
    }
    return tmuxSessionByPaneAncestry(run);
};

/**
 * A one-line notice for a machine that still exports `ZEPH_WS_URL`, or null.
 *
 * The variable is no longer read. Dropping it in silence would repeat the
 * failure it caused — a value that looks like it is in effect while something
 * else decides — so it is read here only to say it is being ignored.
 */
export const legacyWsEnv = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
    const value = env.ZEPH_WS_URL;
    // Same guard resolvedEnv applies: an unexpanded "${ZEPH_WS_URL}" out of an
    // agent's env block is a placeholder, not a value.
    return value && !value.startsWith('${') ? value : undefined;
};

/**
 * What to tell a machine that still exports `ZEPH_WS_URL`, or null. Two
 * messages, because the two situations differ: an export beside a config file
 * is dead weight, while an export on its own is still carrying the value.
 */
export const legacyWsEnvNotice = (
    config: { wsUrl?: string } = {},
    env: NodeJS.ProcessEnv = process.env,
): string | null => {
    if (!legacyWsEnv(env)) return null;
    return config.wsUrl
        ? '[Config] ZEPH_WS_URL is set but ~/.zeph/config.json wins now — the export does nothing and can go.'
        : '[Config] ZEPH_WS_URL is deprecated and will stop being read — move the value to "wsUrl" in ~/.zeph/config.json.';
};
