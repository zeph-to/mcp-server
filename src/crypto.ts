/**
 * Per-device encryption for the MCP server — self-contained ECDH P-256 +
 * AES-256-GCM. Mirrors @zeph/crypto API but bundled inline (no external
 * dependency). Uses Web Crypto API via node:crypto webcrypto — Node.js 18+
 * (the `crypto` global only exists unflagged from Node 19, so we import it).
 *
 * How it works (ADR-0007):
 *
 *   This process holds its own ECDH keypair. The private half is generated
 *   here, written to ~/.config/zeph/device-keys.json, and never leaves the
 *   host — the server only ever sees public keys. A push is encrypted once
 *   with a random AES key, and that key is wrapped separately for each of the
 *   user's registered devices using ECDH(this host, that device).
 *
 *   That makes it end-to-end in the standard sense: the backend stores
 *   ciphertext plus wrapped keys it cannot unwrap.
 *
 * What it still does not give you:
 *   • Forward secrecy — the ECDH secret for a given (sender, device) pair is
 *     static, so a compromise of either private key retroactively opens every
 *     push wrapped for that pair. The per-message AES key is random; its wrap
 *     key is not.
 *   • Authenticity beyond the key pairing — nothing signs `senderPublicKey`,
 *     so a server that swapped it could make a push undecryptable, though not
 *     readable.
 *
 * Superseded scheme: a single account-wide keypair whose private half the
 * backend escrowed so it could sync to new devices. Key escrow was removed
 * server-side (zeph@8a6d21b), which left this client waiting for a private key
 * the API stopped returning — encryption was silently off for months. Nothing
 * here asks for that key any more.
 */

/// <reference lib="dom" />

import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { webcrypto } from 'node:crypto';

// Node 18 has no `crypto` global (unflagged only from 19.0.0) — resolve the
// Web Crypto implementation explicitly so encryption works on the declared
// minimum runtime instead of silently staying disabled.
const crypto = webcrypto as unknown as Crypto;

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

const generateKeyPair = async (): Promise<CryptoKeyPair> =>
  crypto.subtle.generateKey(ECDH_PARAMS, true, ['deriveKey', 'deriveBits']);

const exportKeyPair = async (keyPair: CryptoKeyPair): Promise<ExportedKeyPair> => {
  const [publicRaw, privateRaw] = await Promise.all([
    crypto.subtle.exportKey('spki', keyPair.publicKey),
    crypto.subtle.exportKey('pkcs8', keyPair.privateKey),
  ]);
  return { publicKey: toBase64(publicRaw), privateKey: toBase64(privateRaw) };
};

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

// ─── Recipients ───

/** One target device, as returned by `GET /devices`. */
export interface DeviceRecipient {
  deviceId: string;
  /** Base64 SPKI of that device's per-device public key. */
  publicKey: string;
}

/** deviceId → JSON `{ encryptedKey, keyIv }`, the wire shape the clients parse. */
export type DeviceKeyMap = Record<string, string>;

/**
 * Wrap one raw AES key for every recipient device.
 *
 * The payload is encrypted once and only the 44-byte wrapped key repeats, so
 * an attachment costs one S3 object regardless of how many devices the account
 * has. A recipient whose public key will not import is dropped rather than
 * failing the send — one broken device record must not silence every push.
 */
const wrapForDevices = async (
  rawKey: ArrayBuffer,
  senderPrivateKey: CryptoKey,
  recipients: DeviceRecipient[],
): Promise<DeviceKeyMap> => {
  const entries = await Promise.all(
    recipients.map(async ({ deviceId, publicKey }) => {
      try {
        const sharedKey = await deriveAesKey(senderPrivateKey, await importPublicKey(publicKey));
        const keyIv = crypto.getRandomValues(new Uint8Array(12));
        const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, sharedKey, rawKey);
        return [
          deviceId,
          JSON.stringify({ encryptedKey: toBase64(wrapped), keyIv: toBase64(keyIv.buffer as ArrayBuffer) }),
        ] as const;
      } catch (err) {
        console.error(`[Crypto] Skipping device ${deviceId} — unusable public key:`, err);
        return null;
      }
    }),
  );

  const keyMap: DeviceKeyMap = {};
  for (const entry of entries) {
    if (entry) keyMap[entry[0]] = entry[1];
  }
  if (Object.keys(keyMap).length === 0) throw new Error('No recipient device accepted the wrapped key');
  return keyMap;
};

// ─── Key persistence ───

const KEYS_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'zeph');
// Superseded account-wide keypair. Never written any more; only deleted.
const LEGACY_KEYS_PATH = join(KEYS_DIR, 'keys.json');
const DEVICE_KEYS_PATH = join(KEYS_DIR, 'device-keys.json');

const loadDeviceKeys = (): ExportedKeyPair | null => {
  try {
    const parsed = JSON.parse(readFileSync(DEVICE_KEYS_PATH, 'utf-8')) as ExportedKeyPair;
    return parsed.publicKey && parsed.privateKey ? parsed : null;
  } catch {
    return null;
  }
};

const storeDeviceKeys = (exported: ExportedKeyPair): void => {
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(DEVICE_KEYS_PATH, JSON.stringify(exported, null, 2), { mode: 0o600 });
};

const deleteLegacyKeys = (): void => {
  try { unlinkSync(LEGACY_KEYS_PATH); } catch { /* not present — fine */ }
};

const envIsTrue = (key: string): boolean => {
  const v = process.env[key];
  return !!v && /^(1|true|yes|on)$/i.test(v.trim());
};

// ─── Cached state ───

let cachedKeyPair: CryptoKeyPair | null = null;
let cachedExportedPublicKey: string | null = null;
let cachedLegacyPublicKey: string | null = null;
let initPromise: Promise<string> | null = null;

/**
 * Initialize crypto.
 *
 * Encryption turns on only when the account has explicitly opted in —
 * `encryptionEnabled` from `GET /users/me/keys` is the single authoritative
 * signal (ADR-0008), set from the Zeph app. Server unreachable, flag off, or
 * the hard opt-out below all leave the cache empty and every send plaintext.
 *
 * When it is on, this host generates its own keypair on first use and keeps
 * it. Unlike the superseded scheme this asks the server for nothing but the
 * flag: the private key is created here and stays here.
 *
 * Opt-out: `ZEPH_DISABLE_ENCRYPTION=1` forces crypto off regardless of
 * server state.
 *
 * Safe to call concurrently — deduplicates to a single init.
 * Returns this host's public key when encryption is active, '' otherwise.
 *
 * NOTE: when `apiKey` is provided, `baseUrl` is required.
 */
export const initCrypto = (apiKey?: string, baseUrl?: string): Promise<string> => {
  // Hard opt-out — skip everything, leave cache empty.
  if (envIsTrue('ZEPH_DISABLE_ENCRYPTION')) {
    disableCrypto();
    return Promise.resolve('');
  }

  if (apiKey && !baseUrl) {
    return Promise.reject(new Error(
      'initCrypto: baseUrl is required when apiKey is provided. ' +
      'Pass the resolved config.baseUrl to avoid talking to the wrong environment.',
    ));
  }
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Local-only mode (no apiKey): used by tests and offline setups. There is
    // no flag to consult, so an existing device keypair is adopted and a
    // missing one is not created — generating here would encrypt without any
    // signal that the user asked for it.
    if (!apiKey) {
      const stored = loadDeviceKeys();
      if (!stored) {
        disableCrypto();
        return '';
      }
      cachedKeyPair = await importKeyPair(stored);
      cachedExportedPublicKey = stored.publicKey;
      return stored.publicKey;
    }

    const serverResult = await fetchEncryptionState(apiKey, baseUrl as string);
    if (!serverResult?.encryptionEnabled) {
      disableCrypto();
      // The account says encryption is off. Drop the escrowed account keypair
      // if an old build left one on disk — it holds a private key this process
      // has no use for and the server no longer accepts.
      if (serverResult) deleteLegacyKeys();
      return '';
    }

    const stored = loadDeviceKeys();
    if (stored) {
      cachedKeyPair = await importKeyPair(stored);
      cachedExportedPublicKey = stored.publicKey;
      return stored.publicKey;
    }

    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);
    storeDeviceKeys(exported);
    cachedKeyPair = keyPair;
    cachedExportedPublicKey = exported.publicKey;
    return exported.publicKey;
  })().catch((err) => {
    initPromise = null;
    throw err;
  });
  return initPromise;
};

// ─── Server state ───

interface EncryptionState {
  encryptionEnabled: boolean;
  /**
   * The account-wide public key, when one is still registered. Only used to
   * recognise devices that never migrated: a device advertising this key has
   * no per-device keypair, so wrapping for it produces something it cannot
   * unwrap.
   */
  legacyPublicKey: string | null;
}

const fetchEncryptionState = async (apiKey: string, baseUrl: string): Promise<EncryptionState | null> => {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/users/me/keys`;
    // Bounded: index.ts awaits initCrypto before connecting the MCP
    // transport, so a hanging fetch here would block server startup.
    const res = await fetch(url, {
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const json = await res.json() as {
      data?: { encryptionKeys?: { publicKey?: string } | null; encryptionEnabled?: boolean };
    };
    const state: EncryptionState = {
      encryptionEnabled: json.data?.encryptionEnabled === true,
      legacyPublicKey: json.data?.encryptionKeys?.publicKey ?? null,
    };
    cachedLegacyPublicKey = state.legacyPublicKey;
    return state;
  } catch {
    return null;
  }
};

/**
 * Keep only devices this host can actually encrypt for.
 *
 * A device without a public key has never run a build that registers one, and
 * a device still advertising the account-wide key has not migrated to
 * per-device E2E — wrapping for either produces a push it cannot open, which
 * is worse than sending plaintext it can read.
 */
export const selectRecipients = (
  devices: { deviceId: string; publicKey?: string }[],
): DeviceRecipient[] =>
  devices
    .filter((d): d is DeviceRecipient => !!d.publicKey && d.publicKey !== cachedLegacyPublicKey)
    .map(({ deviceId, publicKey }) => ({ deviceId, publicKey }));

export const getKeyPair = (): CryptoKeyPair | null => cachedKeyPair;
export const getPublicKey = (): string | null => cachedExportedPublicKey;

/**
 * Drop the cached keys so every later send goes out as plaintext.
 *
 * Used when the server refuses an encrypted send with `PRO_REQUIRED`
 * (ADR-0008): E2E is Pro-only, and this server initialized crypto once at
 * startup — a downgrade after that is only visible at send time. Same end
 * state as the `ZEPH_DISABLE_ENCRYPTION` opt-out. Keys on disk are untouched;
 * a restart after an upgrade re-adopts them.
 */
export const disableCrypto = (): void => {
  cachedKeyPair = null;
  cachedExportedPublicKey = null;
};

/**
 * Encrypt a push body for the given recipient devices.
 *
 * Returns the wire fields the API expects: `body` carries the ciphertext and
 * IV, `deviceKeyMap` the per-device wrapped keys, `senderPublicKey` the half
 * recipients need to derive the same secret back.
 */
export const encryptPushBodyForDevices = async (
  input: { title?: string; body?: string; url?: string },
  recipients: DeviceRecipient[],
): Promise<{
  body: string;
  deviceKeyMap: DeviceKeyMap;
  senderPublicKey: string;
  isEncrypted: true;
}> => {
  if (!cachedKeyPair || !cachedExportedPublicKey) throw new Error('Crypto not initialized');

  const messageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    messageKey,
    new TextEncoder().encode(JSON.stringify({ title: input.title, body: input.body, url: input.url })),
  );
  const rawMessageKey = await crypto.subtle.exportKey('raw', messageKey);

  return {
    body: JSON.stringify({ ciphertext: toBase64(ciphertext), iv: toBase64(iv.buffer as ArrayBuffer) }),
    deviceKeyMap: await wrapForDevices(rawMessageKey, cachedKeyPair.privateKey, recipients),
    senderPublicKey: cachedExportedPublicKey,
    isEncrypted: true,
  };
};

/**
 * Encrypt file content for the given recipient devices.
 */
export const encryptFileForDevices = async (
  content: string | Buffer,
  recipients: DeviceRecipient[],
): Promise<{ ciphertext: Buffer; iv: string; deviceKeyMap: DeviceKeyMap }> => {
  if (!cachedKeyPair) throw new Error('Crypto not initialized');

  // Binary attachments arrive as a Buffer and must be encrypted byte for byte —
  // running them through TextEncoder would UTF-8 mangle every non-ASCII byte.
  // Both branches are views; subtle.encrypt honours byteOffset/byteLength, so a
  // Buffer carved out of Node's pool encrypts only its own bytes.
  const buffer =
    typeof content === 'string'
      ? new TextEncoder().encode(content)
      : new Uint8Array(content.buffer as ArrayBuffer, content.byteOffset, content.byteLength);

  const fileKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, fileKey, buffer);
  const rawFileKey = await crypto.subtle.exportKey('raw', fileKey);

  return {
    ciphertext: Buffer.from(ciphertext),
    iv: toBase64(iv.buffer as ArrayBuffer),
    deviceKeyMap: await wrapForDevices(rawFileKey, cachedKeyPair.privateKey, recipients),
  };
};
