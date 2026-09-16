import { ApiError, type ZephApiClient } from './api-client.js';
import { getKeyPair, getPublicKey, disablePushEncryption, isPushEncryptionEnabled, selectRecipients, type DeviceRecipient } from './crypto.js';
import type { DeviceRecord } from './types.js';

export interface SendAudience {
  /** Who the push is encrypted for, or null when it goes out in the clear. */
  recipients: DeviceRecipient[] | null;
  /** The device list those came from — empty when it was never fetched. A
   *  file send reads a local-transfer endpoint from it (ADR-0013). */
  devices: DeviceRecord[];
}

/**
 * Resolve who a push can be encrypted for, or null when it cannot be.
 *
 * Null covers an account that has not opted in to encrypted pushes (ADR-0008)
 * as well as one with nothing to encrypt for. It does not mean this host has
 * no keypair: it has one on any plan, and a local transfer still seals with it
 * (ADR-0013 decision 3) — which is why the device list is returned either way.
 *
 * The device list is fetched per send rather than cached: a phone that
 * registered its key a minute ago must be able to read the next push, and a
 * long-lived MCP process would otherwise keep wrapping for a stale set.
 * A failure here is not fatal — plaintext the user can read beats a
 * notification that never arrives.
 */
export const resolveAudience = async (client: ZephApiClient): Promise<SendAudience> => {
  if (!getKeyPair() || !getPublicKey()) return { recipients: null, devices: [] };
  try {
    const devices = (await client.listDevices()).data;
    if (!isPushEncryptionEnabled()) return { recipients: null, devices };
    const recipients = selectRecipients(devices);
    if (recipients.length === 0) {
      console.error('[Crypto] No device has a per-device public key — sending plaintext.');
      return { recipients: null, devices };
    }
    return { recipients, devices };
  } catch (err) {
    console.error('[Crypto] Could not list devices, sending plaintext:', err);
    return { recipients: null, devices: [] };
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
 * the clear, plus the device list they came from, and must be safe to run twice — the encrypted first upload is
 * left orphaned in S3, which is the accepted cost of not shipping an
 * unreadable attachment. The retry is not itself retried: a second
 * `PRO_REQUIRED` propagates. The keypair survives the retry — only encrypted
 * pushes stop, and a local transfer in the retry still seals with it.
 */
export const withPlaintextFallback = async <T>(
  client: ZephApiClient,
  send: (recipients: DeviceRecipient[] | null, devices: DeviceRecord[]) => Promise<T>,
): Promise<T> => {
  const { recipients, devices } = await resolveAudience(client);
  if (!recipients) return send(null, devices);

  try {
    return await send(recipients, devices);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'PRO_REQUIRED') throw err;
    disablePushEncryption();
    console.error('[Crypto] End-to-end encryption requires Zeph Pro — resending as plaintext.');
    return send(null, devices);
  }
};
