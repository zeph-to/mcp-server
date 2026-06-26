/**
 * Device-shared encryption for MCP server — self-contained ECDH P-256 +
 * AES-256-GCM. Mirrors @zeph/crypto API but bundled inline (no external
 * dependency). Uses Web Crypto API (globalThis.crypto.subtle) — Node.js 18+.
 *
 * Threat model honesty (do not call this "E2E" without a footnote):
 *
 *   The Zeph backend persists the per-user private key in plaintext so it
 *   can be synced down to a fresh device (fetchServerKeys / uploadServerKeys
 *   below). That means the backend can decrypt any push body — this is NOT
 *   end-to-end in the standard sense. What it gives you is:
 *     • Protection against passive network observers
 *     • Protection against a leaked DB snapshot taken without the key store
 *     • Cross-device readability (all your devices share one keypair)
 *   What it does NOT give you:
 *     • Protection against the Zeph backend itself
 *     • Forward secrecy — encryptPushBodyForSelf / encryptFileForSelf do
 *       ECDH(self, self), which collapses to a static derived key. A single
 *       device compromise (since all your devices share the same keypair)
 *       lets the attacker decrypt every past push for which they have the
 *       ciphertext. The per-message AES key is random, but its wrap key is
 *       static, so wrapped keys are decryptable forever.
 *
 *   True E2E would require a per-device keypair (server stores only public
 *   keys; senders wrap the message key once per recipient device public
 *   key). That refactor is on the roadmap; until then, treat push bodies as
 *   sensitive-but-not-secret.
 */

/// <reference lib="dom" />

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// ─── Base64 helpers ───

const toBase64 = (buffer: ArrayBuffer): string =>
  Buffer.from(buffer).toString('base64');

const fromBase64 = (base64: string): ArrayBuffer => {
  const buf = Buffer.from(base64, 'base64');
  // Slice to the exact byte range — Buffer may share a larger pooled
  // ArrayBuffer, so `.buffer` alone could expose unrelated memory.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
};

// ─── ECDH key management ───

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };

interface ExportedKeyPair {
  publicKey: string;   // Base64-encoded SPKI
  privateKey: string;  // Base64-encoded PKCS8
}

// generateKeyPair / exportKeyPair were removed in fix/no-auto-encryption.
// This module imports keys only; it never creates or exports them.

const importPublicKey = async (base64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('spki', fromBase64(base64), ECDH_PARAMS, true, []);

const importPrivateKey = async (base64: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('pkcs8', fromBase64(base64), ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);

const importKeyPair = async (exported: ExportedKeyPair): Promise<CryptoKeyPair> => {
  const [publicKey, privateKey] = await Promise.all([
    importPublicKey(exported.publicKey),
    importPrivateKey(exported.privateKey),
  ]);
  return { publicKey, privateKey };
};

const deriveAesKey = async (privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> =>
  crypto.subtle.deriveKey(
    { name: 'ECDH', public: publicKey },
    privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

// ─── AES-256-GCM encryption ───

interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  encryptedKey: string;
  keyIv: string;
}

const encrypt = async (
  plaintext: string,
  senderPrivateKey: CryptoKey,
  recipientPublicKey: CryptoKey,
): Promise<EncryptedPayload> => {
  const messageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    messageKey,
    new TextEncoder().encode(plaintext),
  );
  const sharedKey = await deriveAesKey(senderPrivateKey, recipientPublicKey);
  const rawMessageKey = await crypto.subtle.exportKey('raw', messageKey);
  const keyIv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, sharedKey, rawMessageKey);

  return {
    ciphertext: toBase64(ciphertext),
    iv: toBase64(iv.buffer as ArrayBuffer),
    encryptedKey: toBase64(encryptedKey),
    keyIv: toBase64(keyIv.buffer as ArrayBuffer),
  };
};

// ─── File encryption ───

const encryptFileContent = async (
  content: string,
  senderPrivateKey: CryptoKey,
  recipientPublicKey: CryptoKey,
): Promise<{ ciphertext: Buffer; iv: string; encryptedKey: string; keyIv: string }> => {
  const buffer = new TextEncoder().encode(content).buffer as ArrayBuffer;
  const fileKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, buffer);

  const sharedKey = await deriveAesKey(senderPrivateKey, recipientPublicKey);
  const rawFileKey = await crypto.subtle.exportKey('raw', fileKey);
  const keyIv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedKey = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, sharedKey, rawFileKey);

  return {
    ciphertext: Buffer.from(ciphertext),
    iv: toBase64(iv.buffer as ArrayBuffer),
    encryptedKey: toBase64(encryptedKey),
    keyIv: toBase64(keyIv.buffer as ArrayBuffer),
  };
};

// ─── Key persistence (~/.config/zeph/keys.json) ───

const KEYS_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'zeph');
const KEYS_PATH = join(KEYS_DIR, 'keys.json');

const loadStoredKeys = (): ExportedKeyPair | null => {
  try {
    return JSON.parse(readFileSync(KEYS_PATH, 'utf-8')) as ExportedKeyPair;
  } catch {
    return null;
  }
};

const storeKeys = (exported: ExportedKeyPair): void => {
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(KEYS_PATH, JSON.stringify(exported, null, 2), { mode: 0o600 });
};

const deleteStoredKeys = (): void => {
  try { unlinkSync(KEYS_PATH); } catch { /* not present — fine */ }
};

const envIsTrue = (key: string): boolean => {
  const v = process.env[key];
  return !!v && /^(1|true|yes|on)$/i.test(v.trim());
};

// ─── Cached state ───

let cachedKeyPair: CryptoKeyPair | null = null;
let cachedExportedPublicKey: string | null = null;
let cachedOwnPublicKey: CryptoKey | null = null;
let initPromise: Promise<string> | null = null;

/**
 * Initialize crypto.
 *
 * The MCP server is a CONSUMER of encryption keys, not a generator. Keys
 * are created in the Zeph app where the user explicitly opts in (Settings
 * → Encryption). This function only imports keys that the server already
 * has, and only when the server confirms encryption is enabled.
 *
 * Any other state — server says disabled, server has no keys, server is
 * unreachable — leaves encryption OFF (cache empty, no fallback). A
 * previous version generated and uploaded a fresh keypair on the "no keys
 * anywhere" path; combined with a transient fetch failure, that silently
 * turned encryption on without user consent and locked the account into
 * an "encryption enabled" state on the server.
 *
 * Opt-out: `ZEPH_DISABLE_ENCRYPTION=1` forces crypto off regardless of
 * server state — useful while cleaning up legacy state or for users who
 * never want encryption.
 *
 * Safe to call concurrently — deduplicates to single init.
 * Returns the exported public key when encryption is active, '' otherwise.
 *
 * NOTE: when `apiKey` is provided, `baseUrl` is required.
 */
export const initCrypto = (apiKey?: string, baseUrl?: string): Promise<string> => {
  // Hard opt-out — skip everything, leave cache empty.
  if (envIsTrue('ZEPH_DISABLE_ENCRYPTION')) {
    cachedKeyPair = null;
    cachedExportedPublicKey = null;
    cachedOwnPublicKey = null;
    return Promise.resolve('');
  }

  if (apiKey && !baseUrl) {
    return Promise.reject(new Error(
      'initCrypto: baseUrl is required when apiKey is provided. ' +
      'Pass the resolved config.baseUrl to avoid talking to the wrong environment.',
    ));
  }
  if (initPromise) return initPromise;
  const baseUrlRequired: string | undefined = apiKey ? baseUrl as string : baseUrl;

  initPromise = (async () => {
    if (apiKey) {
      const serverResult = await fetchServerKeys(apiKey, baseUrlRequired as string);

      // The only path that turns encryption ON: server confirms enabled AND
      // hands us a real keypair. Everything else leaves the cache empty.
      const haveServerKeys =
        !!serverResult && serverResult.encryptionEnabled && !!serverResult.keys;

      if (!haveServerKeys) {
        cachedKeyPair = null;
        cachedExportedPublicKey = null;
        cachedOwnPublicKey = null;
        // If the server is reachable and explicitly says encryption is off,
        // drop any stale local cache so a future regression can't resurrect
        // a keypair that the user already disabled.
        if (serverResult && !serverResult.encryptionEnabled) {
          deleteStoredKeys();
        }
        return '';
      }

      const keys = serverResult!.keys!;
      const stored = loadStoredKeys();
      if (!stored || stored.publicKey !== keys.publicKey) {
        storeKeys(keys);
      }
      cachedKeyPair = await importKeyPair(keys);
      cachedExportedPublicKey = keys.publicKey;
      cachedOwnPublicKey = cachedKeyPair.publicKey;
      return keys.publicKey;
    }

    // Local-only mode (no apiKey): load stored keys if they exist; do NOT
    // generate. Used by tests and offline / pre-provisioned setups where
    // a keypair has been dropped into ~/.config/zeph/keys.json out-of-band.
    const stored = loadStoredKeys();
    if (!stored) {
      cachedKeyPair = null;
      cachedExportedPublicKey = null;
      cachedOwnPublicKey = null;
      return '';
    }
    cachedKeyPair = await importKeyPair(stored);
    cachedExportedPublicKey = stored.publicKey;
    cachedOwnPublicKey = cachedKeyPair.publicKey;
    return stored.publicKey;
  })().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
};

// ─── Server key sync helpers ───

interface ServerKeysResult {
  keys: ExportedKeyPair | null;
  encryptionEnabled: boolean;
}

const fetchServerKeys = async (apiKey: string, baseUrl: string): Promise<ServerKeysResult | null> => {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/users/me/keys`;
    const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
    if (!res.ok) return null;
    const json = await res.json() as { data?: { encryptionKeys?: ExportedKeyPair | null; encryptionEnabled?: boolean } };
    const keys = json.data?.encryptionKeys;
    const encryptionEnabled = json.data?.encryptionEnabled ?? (keys ? true : false);
    return {
      keys: keys?.publicKey && keys?.privateKey ? keys : null,
      encryptionEnabled,
    };
  } catch {
    return null;
  }
};

// uploadServerKeys was removed in fix/no-auto-encryption — the MCP server
// must never write to /users/me/keys. Keys are created by the Zeph app
// where the user explicitly opts in.

export const getKeyPair = (): CryptoKeyPair | null => cachedKeyPair;
export const getPublicKey = (): string | null => cachedExportedPublicKey;

/**
 * Encrypt push body for self (all own devices).
 */
export const encryptPushBodyForSelf = async (
  input: { title?: string; body?: string; url?: string },
): Promise<{
  body: string;
  encryptedKey: string;
  senderPublicKey: string;
  isEncrypted: true;
}> => {
  if (!cachedKeyPair || !cachedExportedPublicKey || !cachedOwnPublicKey) throw new Error('Crypto not initialized');
  const payload = await encrypt(
    JSON.stringify({ title: input.title, body: input.body, url: input.url }),
    cachedKeyPair.privateKey,
    cachedOwnPublicKey,
  );
  return {
    body: JSON.stringify({ ciphertext: payload.ciphertext, iv: payload.iv }),
    encryptedKey: JSON.stringify({ encryptedKey: payload.encryptedKey, keyIv: payload.keyIv }),
    senderPublicKey: cachedExportedPublicKey,
    isEncrypted: true,
  };
};

/**
 * Encrypt file content for self (all own devices).
 */
export const encryptFileForSelf = async (
  content: string,
): Promise<{ ciphertext: Buffer; iv: string; encryptedKey: string }> => {
  if (!cachedKeyPair || !cachedOwnPublicKey) throw new Error('Crypto not initialized');
  const result = await encryptFileContent(content, cachedKeyPair.privateKey, cachedOwnPublicKey);
  return {
    ciphertext: result.ciphertext,
    iv: result.iv,
    encryptedKey: JSON.stringify({ encryptedKey: result.encryptedKey, keyIv: result.keyIv }),
  };
};
