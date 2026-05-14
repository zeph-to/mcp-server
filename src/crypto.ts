/**
 * E2E encryption for MCP server — ECDH P-256 + AES-256-GCM
 * Uses user-level key pair from server (GET /users/me/keys).
 * All devices share the same key → self-encrypt works for all.
 */

/// <reference lib="dom" />

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { ZephApiClient } from './api-client.js';

// ─── Base64 helpers ───

const toBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const fromBase64 = (base64: string): ArrayBuffer => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
};

// ─── ECDH key management ───

const ECDH_PARAMS: EcKeyGenParams = { name: 'ECDH', namedCurve: 'P-256' };

interface ExportedKeyPair {
  publicKey: string;
  privateKey: string;
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

// ─── AES-256-GCM encryption ───

const encrypt = async (
  plaintext: string,
  senderPrivateKey: CryptoKey,
  recipientPublicKey: CryptoKey,
): Promise<{ ciphertext: string; iv: string; encryptedKey: string; keyIv: string }> => {
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

// ─── Local key cache (~/.config/zeph/keys.json) ───

const KEYS_DIR = join(process.env.HOME ?? '~', '.config', 'zeph');
const KEYS_PATH = join(KEYS_DIR, 'keys.json');

const loadLocalKeys = (): ExportedKeyPair | null => {
  try {
    return JSON.parse(readFileSync(KEYS_PATH, 'utf-8')) as ExportedKeyPair;
  } catch {
    return null;
  }
};

const saveLocalKeys = (exported: ExportedKeyPair): void => {
  mkdirSync(KEYS_DIR, { recursive: true });
  writeFileSync(KEYS_PATH, JSON.stringify(exported, null, 2), { mode: 0o600 });
};

// ─── Cached state ───

let cachedKeyPair: CryptoKeyPair | null = null;
let cachedExportedPublicKey: string | null = null;
let initPromise: Promise<string> | null = null;

/**
 * Initialize crypto with user-level keys.
 * Priority: local cache → server fetch → generate + upload.
 * All devices of the same user share the same key pair.
 */
export const initCrypto = (client: ZephApiClient): Promise<string> => {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // 1. Try local cache
    const local = loadLocalKeys();
    if (local) {
      cachedKeyPair = await importKeyPair(local);
      cachedExportedPublicKey = local.publicKey;
      // Upload to server if missing (fire-and-forget, skip GET — just PUT idempotently)
      client.putMyKeys(local).catch(() => {});
      return local.publicKey;
    }

    // 2. Try server fetch
    try {
      const res = await client.getMyKeys();
      const serverKeys = res.data.encryptionKeys;
      if (serverKeys?.publicKey && serverKeys?.privateKey) {
        cachedKeyPair = await importKeyPair(serverKeys);
        cachedExportedPublicKey = serverKeys.publicKey;
        saveLocalKeys(serverKeys);
        return serverKeys.publicKey;
      }
    } catch {
      // Server fetch failed
    }

    // 3. Generate + save locally + upload to server
    const keyPair = await generateKeyPair();
    const exported = await exportKeyPair(keyPair);
    saveLocalKeys(exported);
    cachedKeyPair = keyPair;
    cachedExportedPublicKey = exported.publicKey;

    client.putMyKeys(exported).catch(() => {});
    return exported.publicKey;
  })().catch((err) => {
    initPromise = null; // allow retry on next call
    throw err;
  });
  return initPromise;
};

export const getKeyPair = (): CryptoKeyPair | null => cachedKeyPair;
export const getPublicKey = (): string | null => cachedExportedPublicKey;

/**
 * Encrypt push body (self-encrypt — all devices share same key).
 */
export const encryptPushBody = async (
  input: { title?: string; body?: string; url?: string },
): Promise<{
  body: string;
  encryptedKey: string;
  senderPublicKey: string;
  isEncrypted: true;
} | null> => {
  if (!cachedKeyPair || !cachedExportedPublicKey) return null;

  const payload = await encrypt(
    JSON.stringify({ title: input.title, body: input.body, url: input.url }),
    cachedKeyPair.privateKey,
    cachedKeyPair.publicKey,
  );

  return {
    body: JSON.stringify({ ciphertext: payload.ciphertext, iv: payload.iv }),
    encryptedKey: JSON.stringify({ encryptedKey: payload.encryptedKey, keyIv: payload.keyIv }),
    senderPublicKey: cachedExportedPublicKey,
    isEncrypted: true,
  };
};

/**
 * Encrypt file content (self-encrypt).
 */
export const encryptFileForSelf = async (
  content: string,
): Promise<{ ciphertext: Buffer; iv: string; encryptedKey: string } | null> => {
  if (!cachedKeyPair) return null;

  const result = await encryptFileContent(content, cachedKeyPair.privateKey, cachedKeyPair.publicKey);
  return {
    ciphertext: result.ciphertext,
    iv: result.iv,
    encryptedKey: JSON.stringify({ encryptedKey: result.encryptedKey, keyIv: result.keyIv }),
  };
};
