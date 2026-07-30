import { ApiError } from './api-client.js';
import { getKeyPair, getPublicKey, disableCrypto } from './crypto.js';

/**
 * Run a send, and repeat it unencrypted if the server says E2E needs Pro.
 *
 * E2E is Pro-only (ADR-0008) and `POST /pushes/send` rejects `isEncrypted`
 * from a free account with 403 `PRO_REQUIRED`. Crypto initializes once at
 * server startup, so a downgrade after that is only visible at send time — and
 * a notification must not be lost over a billing state change. The keys are
 * dropped before the retry, so later sends skip encryption outright and the
 * retry rebuilds the whole payload (a file re-uploads as plaintext instead of
 * leaving an undecryptable blob in S3).
 *
 * `send` receives whether it may encrypt, and must be safe to run twice — the
 * encrypted first upload is left orphaned in S3, which is the accepted cost of
 * not shipping an unreadable attachment. The retry is not itself retried: a
 * second `PRO_REQUIRED` propagates.
 */
export const withPlaintextFallback = async <T>(
  send: (canEncrypt: boolean) => Promise<T>,
): Promise<T> => {
  const canEncrypt = !!getKeyPair() && !!getPublicKey();
  if (!canEncrypt) return send(false);

  try {
    return await send(true);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'PRO_REQUIRED') throw err;
    disableCrypto();
    console.error('[Crypto] End-to-end encryption requires Zeph Pro — resending as plaintext.');
    return send(false);
  }
};
