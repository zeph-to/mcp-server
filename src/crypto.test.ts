import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// crypto.ts caches a keypair at module scope. We use vi.resetModules() in
// every test to start from a clean slate and point HOME at a temp dir so
// the on-disk keystore never touches the developer's real ~/.config/zeph.
//
// IMPORTANT: do not reassign process.env — that detaches the JS object
// from the native getenv() that os.homedir() reads. Set individual keys.

const CRYPTO_ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME', 'ZEPH_DISABLE_ENCRYPTION'] as const;
const originalEnv: Record<string, string | undefined> = {};
for (const key of CRYPTO_ENV_KEYS) originalEnv[key] = process.env[key];

let TMP: string;

beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), 'mcp-crypto-test-'));
    for (const key of CRYPTO_ENV_KEYS) delete process.env[key];
    process.env.HOME = TMP;
    vi.resetModules();
    vi.unstubAllGlobals();
});

afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    for (const key of CRYPTO_ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
    vi.unstubAllGlobals();
});

// ── Helpers ──

/** Generate a base64-encoded ECDH P-256 keypair we can hand to the fake server. */
const makeKeyPair = async (): Promise<{ publicKey: string; privateKey: string }> => {
    const kp = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey', 'deriveBits'],
    );
    const [pubSpki, privPkcs8] = await Promise.all([
        crypto.subtle.exportKey('spki', kp.publicKey),
        crypto.subtle.exportKey('pkcs8', kp.privateKey),
    ]);
    const toB64 = (buf: ArrayBuffer): string => Buffer.from(new Uint8Array(buf)).toString('base64');
    return { publicKey: toB64(pubSpki), privateKey: toB64(privPkcs8) };
};

const stubServer = (data: { encryptionEnabled: boolean; encryptionKeys: { publicKey: string; privateKey: string } | null }): void => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ data }),
    } as unknown as Response)));
};

const writeLocalKeys = (root: string, keys: { publicKey: string; privateKey: string }): string => {
    const dir = join(root, '.config', 'zeph');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'keys.json');
    writeFileSync(path, JSON.stringify(keys));
    return path;
};

const fetchCalls = (): { url: string; method: string }[] => {
    const calls = (fetch as unknown as { mock?: { calls: unknown[][] } }).mock?.calls ?? [];
    return calls.map((args) => ({
        url: String(args[0]),
        method: ((args[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase(),
    }));
};

// ── initCrypto ──

describe('initCrypto', () => {
    it('rejects when apiKey is provided but baseUrl is not', async () => {
        const { initCrypto } = await import('./crypto.js');
        await expect(initCrypto('ak_test')).rejects.toThrow(/baseUrl is required/);
    });

    it('imports + caches keys when the server has them and encryption is enabled', async () => {
        const keys = await makeKeyPair();
        stubServer({ encryptionEnabled: true, encryptionKeys: keys });
        const { initCrypto, getPublicKey, getKeyPair } = await import('./crypto.js');

        const pub = await initCrypto('ak_test', 'https://api.example.com/v1');

        expect(pub).toBe(keys.publicKey);
        expect(getPublicKey()).toBe(keys.publicKey);
        expect(getKeyPair()).not.toBeNull();
        // Persisted locally for fast next-start
        expect(existsSync(join(TMP, '.config', 'zeph', 'keys.json'))).toBe(true);
    });

    it('NEVER generates or uploads when the server has no keys', async () => {
        // The previous version generated a fresh keypair here and uploaded
        // it via PUT /users/me/keys — silently turning encryption on for
        // anyone who started the MCP without ever opting in.
        stubServer({ encryptionEnabled: true, encryptionKeys: null });
        const { initCrypto, getPublicKey, getKeyPair } = await import('./crypto.js');

        const pub = await initCrypto('ak_test', 'https://api.example.com/v1');

        expect(pub).toBe('');
        expect(getPublicKey()).toBeNull();
        expect(getKeyPair()).toBeNull();
        // No local cache should have been created.
        expect(existsSync(join(TMP, '.config', 'zeph', 'keys.json'))).toBe(false);
        // And critically — no PUT (upload). Only the single GET.
        const calls = fetchCalls();
        expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    });

    it('NEVER generates or uploads when fetchServerKeys is unreachable', async () => {
        // A transient network failure used to trigger the auto-generate
        // path. Now it must leave the cache empty and not touch the server.
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
        const { initCrypto, getPublicKey, getKeyPair } = await import('./crypto.js');

        const pub = await initCrypto('ak_test', 'https://api.example.com/v1');

        expect(pub).toBe('');
        expect(getPublicKey()).toBeNull();
        expect(getKeyPair()).toBeNull();
        // No PUT on a transient failure — and the local file isn't deleted
        // either, since we can't trust the server state on an error.
    });

    it('clears the cache AND deletes stale local keys when server says disabled', async () => {
        // Plant a stale local cache from a prior buggy run.
        const stale = await makeKeyPair();
        const keysPath = writeLocalKeys(TMP, stale);
        expect(existsSync(keysPath)).toBe(true);

        stubServer({ encryptionEnabled: false, encryptionKeys: null });
        const { initCrypto, getPublicKey, getKeyPair } = await import('./crypto.js');

        const pub = await initCrypto('ak_test', 'https://api.example.com/v1');

        expect(pub).toBe('');
        expect(getPublicKey()).toBeNull();
        expect(getKeyPair()).toBeNull();
        // Stale local cache must be removed so nothing can resurrect it.
        expect(existsSync(keysPath)).toBe(false);
    });

    it('ZEPH_DISABLE_ENCRYPTION=1 forces crypto off even when the server has keys', async () => {
        const keys = await makeKeyPair();
        stubServer({ encryptionEnabled: true, encryptionKeys: keys });
        process.env.ZEPH_DISABLE_ENCRYPTION = '1';
        const { initCrypto, getPublicKey, getKeyPair } = await import('./crypto.js');

        const pub = await initCrypto('ak_test', 'https://api.example.com/v1');

        expect(pub).toBe('');
        expect(getPublicKey()).toBeNull();
        expect(getKeyPair()).toBeNull();
        // No fetch at all — the opt-out short-circuits before any network call.
        expect(fetchCalls().length).toBe(0);
    });

    it('local-only mode (no apiKey) returns empty when no stored keys exist', async () => {
        const { initCrypto, getPublicKey } = await import('./crypto.js');
        const pub = await initCrypto();
        expect(pub).toBe('');
        expect(getPublicKey()).toBeNull();
        // It must NOT generate one as a fallback.
        expect(existsSync(join(TMP, '.config', 'zeph', 'keys.json'))).toBe(false);
    });

    it('local-only mode imports a pre-provisioned keys.json', async () => {
        const keys = await makeKeyPair();
        writeLocalKeys(TMP, keys);
        const { initCrypto, getPublicKey } = await import('./crypto.js');
        const pub = await initCrypto();
        expect(pub).toBe(keys.publicKey);
        expect(getPublicKey()).toBe(keys.publicKey);
    });

    it('respects $XDG_CONFIG_HOME for key storage', async () => {
        const keys = await makeKeyPair();
        const xdg = join(TMP, 'xdg-config');
        process.env.XDG_CONFIG_HOME = xdg;
        stubServer({ encryptionEnabled: true, encryptionKeys: keys });
        vi.resetModules();
        const { initCrypto } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');
        expect(existsSync(join(xdg, 'zeph', 'keys.json'))).toBe(true);
        expect(existsSync(join(TMP, '.config', 'zeph', 'keys.json'))).toBe(false);
    });

    it('deduplicates concurrent initCrypto calls (single fetch)', async () => {
        const keys = await makeKeyPair();
        stubServer({ encryptionEnabled: true, encryptionKeys: keys });
        const { initCrypto } = await import('./crypto.js');

        const [a, b] = await Promise.all([
            initCrypto('ak_test', 'https://api.example.com/v1'),
            initCrypto('ak_test', 'https://api.example.com/v1'),
        ]);

        expect(a).toBe(b);
        expect(fetchCalls().length).toBe(1);
    });
});

// ── encryptPushBodyForSelf ──

describe('encryptPushBodyForSelf', () => {
    it('returns a complete encrypted envelope', async () => {
        const keys = await makeKeyPair();
        stubServer({ encryptionEnabled: true, encryptionKeys: keys });
        const { initCrypto, encryptPushBodyForSelf } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');

        const enc = await encryptPushBodyForSelf({ title: 'hi', body: 'hello world', url: 'https://x.test' });
        expect(enc.isEncrypted).toBe(true);
        expect(enc.senderPublicKey).toBeTruthy();
        const parsed = JSON.parse(enc.body);
        expect(parsed).toHaveProperty('ciphertext');
        expect(parsed).toHaveProperty('iv');
        const keyEnv = JSON.parse(enc.encryptedKey);
        expect(keyEnv).toHaveProperty('encryptedKey');
        expect(keyEnv).toHaveProperty('keyIv');
        expect(parsed.ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('produces different ciphertext on repeated calls (random IV)', async () => {
        const keys = await makeKeyPair();
        stubServer({ encryptionEnabled: true, encryptionKeys: keys });
        const { initCrypto, encryptPushBodyForSelf } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');

        const a = await encryptPushBodyForSelf({ body: 'same text' });
        const b = await encryptPushBodyForSelf({ body: 'same text' });
        expect(JSON.parse(a.body).ciphertext).not.toBe(JSON.parse(b.body).ciphertext);
    });

    it('throws when called before initCrypto', async () => {
        const { encryptPushBodyForSelf } = await import('./crypto.js');
        await expect(encryptPushBodyForSelf({ body: 'x' })).rejects.toThrow(/Crypto not initialized/);
    });
});

// ── encryptFileForSelf ──

describe('encryptFileForSelf', () => {
    it('returns ciphertext buffer + iv + wrapped key', async () => {
        const keys = await makeKeyPair();
        stubServer({ encryptionEnabled: true, encryptionKeys: keys });
        const { initCrypto, encryptFileForSelf } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');

        const enc = await encryptFileForSelf('file content here');
        expect(Buffer.isBuffer(enc.ciphertext)).toBe(true);
        expect(enc.ciphertext.length).toBeGreaterThan(0);
        expect(enc.iv).toMatch(/^[A-Za-z0-9+/=]+$/);
        const keyEnv = JSON.parse(enc.encryptedKey);
        expect(keyEnv).toHaveProperty('encryptedKey');
        expect(keyEnv).toHaveProperty('keyIv');
    });
});
