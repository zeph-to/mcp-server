import { ApiError, type ZephApiClient } from './api-client.js';
import { getKeyPair, getPublicKey, disablePushEncryption, isPushEncryptionEnabled, selectRecipients, type DeviceRecipient } from './crypto.js';

/**
 * Resolve who a push can be encrypted for, or null when it cannot be.
 *
 * Null covers an account that has not opted in to encrypted pushes (ADR-0008)
 * as well as one with nothing to encrypt for. It does not mean this host has
 * no keypair: it has one on any plan, because the keypair is this host's
 * identity rather than an encryption setting (ADR-0013 decision 3).
 *
 * The device list is fetched per send rather than cached: a phone that
 * registered its key a minute ago must be able to read the next push, and a
 * long-lived MCP process would otherwise keep wrapping for a stale set. It is
 * not fetched at all when there is nothing to wrap — a free account paid a
 * `/devices` round trip per send for a list it then threw away. A failure here
 * is not fatal: plaintext the user can read beats a notification that never
 * arrives.
 */
export const resolveAudience = async (client: ZephApiClient): Promise<DeviceRecipient[] | null> => {
  if (!getKeyPair() || !getPublicKey() || !isPushEncryptionEnabled()) return null;
  try {
    const devices = (await client.listDevices()).data;
    const recipients = selectRecipients(devices);
    if (recipients.length === 0) {
      console.error('[Crypto] No device has a per-device public key — sending plaintext.');
      return null;
    }
    return recipients;
  } catch (err) {
    console.error('[Crypto] Could not list devices, sending plaintext:', err);
    return null;
  }
};

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
 * `send` receives the recipient devices, or null when the push must go out in
 * the clear, and must be safe to run twice — the encrypted first upload is
 * left orphaned in S3, which is the accepted cost of not shipping an
 * unreadable attachment. The retry is not itself retried: a second
 * `PRO_REQUIRED` propagates. The keypair survives the retry: it is this host's
 * identity, and only encrypted pushes stop.
 */
export const withPlaintextFallback = async <T>(
  client: ZephApiClient,
  send: (recipients: DeviceRecipient[] | null) => Promise<T>,
): Promise<T> => {
  const recipients = await resolveAudience(client);
  if (!recipients) return send(null);

  try {
    return await send(recipients);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'PRO_REQUIRED') throw err;
    disablePushEncryption();
    console.error('[Crypto] End-to-end encryption requires Zeph Pro — resending as plaintext.');
    return send(null);
  }
};
