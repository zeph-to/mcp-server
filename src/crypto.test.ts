import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// crypto.ts caches a keypair at module scope. We use vi.resetModules() in
// every test to start from a clean slate and point HOME at a temp dir so
// the on-disk keystore doesn't pollute the developer's real ~/.config/zeph.
//
// IMPORTANT: do not reassign process.env — that detaches the JS object
// from the native getenv() that os.homedir() reads. Set individual keys.

const CRYPTO_ENV_KEYS = ['HOME', 'XDG_CONFIG_HOME'] as const;
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

// Minimal stub for the /users/me/keys endpoint. When the test passes an
// apiKey to initCrypto, the module calls fetch(...) — we want it to
// behave like a server that's never seen this user before so the module
// generates a fresh keypair locally.
const stubServerWithNoKeys = (): void => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: { encryptionEnabled: true, encryptionKeys: null } }),
    } as unknown as Response)));
};

describe('initCrypto', () => {
    it('generates and persists a keypair when none exists locally', async () => {
        stubServerWithNoKeys();
        const { initCrypto, getPublicKey } = await import('./crypto.js');
        const pub = await initCrypto('ak_test', 'https://api.example.com/v1');
        expect(pub).toBeTruthy();
        expect(getPublicKey()).toBe(pub);
        // Stored to disk
        const keysPath = join(TMP, '.config', 'zeph', 'keys.json');
        expect(existsSync(keysPath)).toBe(true);
        const stored = JSON.parse(readFileSync(keysPath, 'utf-8'));
        expect(stored).toHaveProperty('publicKey');
        expect(stored).toHaveProperty('privateKey');
    });

    it('rejects when apiKey is provided but baseUrl is not', async () => {
        const { initCrypto } = await import('./crypto.js');
        await expect(initCrypto('ak_test')).rejects.toThrow(/baseUrl is required/);
    });

    it('local-only mode works without apiKey or baseUrl', async () => {
        const { initCrypto, getPublicKey } = await import('./crypto.js');
        const pub = await initCrypto();
        expect(pub).toBeTruthy();
        expect(getPublicKey()).toBe(pub);
    });

    it('respects $XDG_CONFIG_HOME for key storage', async () => {
        const xdg = join(TMP, 'xdg-config');
        process.env.XDG_CONFIG_HOME = xdg;
        vi.resetModules();
        const { initCrypto } = await import('./crypto.js');
        await initCrypto();
        expect(existsSync(join(xdg, 'zeph', 'keys.json'))).toBe(true);
        // And NOT under the default ~/.config/zeph/
        expect(existsSync(join(TMP, '.config', 'zeph', 'keys.json'))).toBe(false);
    });

    it('skips crypto init when server says encryption is disabled', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ data: { encryptionEnabled: false, encryptionKeys: null } }),
        } as unknown as Response)));
        const { initCrypto, getPublicKey, getKeyPair } = await import('./crypto.js');
        const pub = await initCrypto('ak_test', 'https://api.example.com/v1');
        expect(pub).toBe('');
        expect(getPublicKey()).toBe(null);
        expect(getKeyPair()).toBe(null);
    });

    it('deduplicates concurrent initCrypto calls', async () => {
        stubServerWithNoKeys();
        const { initCrypto } = await import('./crypto.js');
        const [a, b] = await Promise.all([
            initCrypto('ak_test', 'https://api.example.com/v1'),
            initCrypto('ak_test', 'https://api.example.com/v1'),
        ]);
        // Same publicKey both times
        expect(a).toBe(b);
        // fetch called only once for keys (the dedup target)
        const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
        expect(calls.length).toBeLessThanOrEqual(2); // GET + PUT at most
    });
});

describe('encryptPushBodyForSelf', () => {
    it('returns a complete encrypted envelope', async () => {
        stubServerWithNoKeys();
        const { initCrypto, encryptPushBodyForSelf } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');

        const enc = await encryptPushBodyForSelf({ title: 'hi', body: 'hello world', url: 'https://x.test' });
        expect(enc.isEncrypted).toBe(true);
        expect(enc.senderPublicKey).toBeTruthy();
        // body is JSON containing base64 ciphertext + iv
        const parsed = JSON.parse(enc.body);
        expect(parsed).toHaveProperty('ciphertext');
        expect(parsed).toHaveProperty('iv');
        const keyEnv = JSON.parse(enc.encryptedKey);
        expect(keyEnv).toHaveProperty('encryptedKey');
        expect(keyEnv).toHaveProperty('keyIv');
        // base64 sanity
        expect(parsed.ciphertext).toMatch(/^[A-Za-z0-9+/=]+$/);
    });

    it('produces different ciphertext on repeated calls (random IV)', async () => {
        stubServerWithNoKeys();
        const { initCrypto, encryptPushBodyForSelf } = await import('./crypto.js');
        await initCrypto('ak_test', 'https://api.example.com/v1');

        const a = await encryptPushBodyForSelf({ body: 'same text' });
        const b = await encryptPushBodyForSelf({ body: 'same text' });
        const ca = JSON.parse(a.body).ciphertext;
        const cb = JSON.parse(b.body).ciphertext;
        expect(ca).not.toBe(cb);
    });

    it('throws when called before initCrypto', async () => {
        const { encryptPushBodyForSelf } = await import('./crypto.js');
        await expect(encryptPushBodyForSelf({ body: 'x' })).rejects.toThrow(/Crypto not initialized/);
    });
});

describe('encryptFileForSelf', () => {
    it('returns ciphertext buffer + iv + wrapped key', async () => {
        stubServerWithNoKeys();
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

describe('key persistence', () => {
    it('reuses stored keys on second init (same exported publicKey)', async () => {
        stubServerWithNoKeys();
        const first = await (await import('./crypto.js')).initCrypto('ak_test', 'https://api.example.com/v1');
        vi.resetModules();
        // Server now returns nothing again, but local file exists — module
        // should load the stored keypair and uploadServerKeys (which we
        // don't assert on; just make sure pub key matches).
        stubServerWithNoKeys();
        const second = await (await import('./crypto.js')).initCrypto('ak_test', 'https://api.example.com/v1');
        expect(second).toBe(first);
    });
});
