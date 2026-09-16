import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./crypto.js', () => ({
    getKeyPair: vi.fn(() => null),
    getPublicKey: vi.fn(() => null),
    selectRecipients: vi.fn((devices: { deviceId: string; publicKey?: string }[]) =>
        devices.filter((d) => !!d.publicKey),
    ),
    disablePushEncryption: vi.fn(),
    isPushEncryptionEnabled: vi.fn(() => true),
}));

import { withPlaintextFallback, resolveAudience } from './e2e-fallback.js';
import { ApiError, type ZephApiClient } from './api-client.js';
import { getKeyPair, getPublicKey, disablePushEncryption, isPushEncryptionEnabled } from './crypto.js';

const withKeys = () => {
    vi.mocked(getKeyPair).mockReturnValue({} as CryptoKeyPair);
    vi.mocked(getPublicKey).mockReturnValue('my-public-key');
};

const clientWith = (devices: { deviceId: string; publicKey?: string }[]) =>
    ({ listDevices: vi.fn(async () => ({ data: devices })) } as unknown as ZephApiClient);

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getKeyPair).mockReturnValue(null);
    vi.mocked(getPublicKey).mockReturnValue(null);
    vi.mocked(isPushEncryptionEnabled).mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('resolveAudience', () => {
    it('returns null when this process has no keypair', async () => {
        const client = clientWith([{ deviceId: 'dev_a', publicKey: 'pub_a' }]);

        expect((await resolveAudience(client)).recipients).toBeNull();
        // Nothing to encrypt with, so the device list is never even fetched.
        expect(client.listDevices).not.toHaveBeenCalled();
    });

    it('returns the devices that carry a public key', async () => {
        withKeys();
        const devices = [{ deviceId: 'dev_a', publicKey: 'pub_a' }, { deviceId: 'dev_b' }];
        const audience = await resolveAudience(clientWith(devices));

        expect(audience.recipients).toEqual([{ deviceId: 'dev_a', publicKey: 'pub_a' }]);
        expect(audience.devices).toEqual(devices);   // the whole list, for a file send's LAN endpoint
    });

    it('returns no recipients but still the devices when the account does not send encrypted pushes', async () => {
        withKeys();
        vi.mocked(isPushEncryptionEnabled).mockReturnValue(false);
        const devices = [{ deviceId: 'dev_a', publicKey: 'pub_a' }];
        const audience = await resolveAudience(clientWith(devices));

        // Encrypted pushes need Pro (ADR-0008); a local transfer does not, and
        // it reads its endpoint out of this list — so the list still comes back.
        expect(audience.recipients).toBeNull();
        expect(audience.devices).toEqual(devices);
    });

    it('falls back to plaintext when no device can receive an encrypted push', async () => {
        withKeys();
        // Ciphertext nobody holds a key for is worse than plaintext the user
        // can read — the notification still has to arrive.
        expect((await resolveAudience(clientWith([{ deviceId: 'dev_b' }]))).recipients).toBeNull();
    });

    it('falls back to plaintext when the device list cannot be fetched', async () => {
        withKeys();
        const client = { listDevices: vi.fn(async () => { throw new Error('offline'); }) } as unknown as ZephApiClient;

        expect((await resolveAudience(client)).recipients).toBeNull();
    });
});

describe('withPlaintextFallback', () => {
    it('runs the send once with recipients when encryption is available', async () => {
        withKeys();
        const send = vi.fn(async () => 'ok');

        expect(await withPlaintextFallback(clientWith([{ deviceId: 'dev_a', publicKey: 'pub_a' }]), send)).toBe('ok');
        expect(send).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledWith([{ deviceId: 'dev_a', publicKey: 'pub_a' }], [{ deviceId: 'dev_a', publicKey: 'pub_a' }]);
    });

    it('runs the send once with null when encryption is unavailable', async () => {
        const send = vi.fn(async () => 'ok');

        await withPlaintextFallback(clientWith([]), send);
        expect(send).toHaveBeenCalledWith(null, []);
    });

    it('drops the keys and retries in the clear on PRO_REQUIRED', async () => {
        withKeys();
        const send = vi
            .fn()
            .mockRejectedValueOnce(new ApiError('needs pro', 'PRO_REQUIRED', 403))
            .mockResolvedValueOnce('plain');

        expect(await withPlaintextFallback(clientWith([{ deviceId: 'dev_a', publicKey: 'pub_a' }]), send)).toBe('plain');
        expect(disablePushEncryption).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[1][0]).toBeNull();
    });

    it('propagates any other error without retrying', async () => {
        withKeys();
        const send = vi.fn().mockRejectedValue(new ApiError('over limit', 'QUOTA_EXCEEDED', 403));

        await expect(
            withPlaintextFallback(clientWith([{ deviceId: 'dev_a', publicKey: 'pub_a' }]), send),
        ).rejects.toThrow('over limit');
        expect(send).toHaveBeenCalledTimes(1);
        expect(disablePushEncryption).not.toHaveBeenCalled();
    });

    it('does not retry a second PRO_REQUIRED', async () => {
        withKeys();
        const send = vi.fn().mockRejectedValue(new ApiError('needs pro', 'PRO_REQUIRED', 403));

        await expect(
            withPlaintextFallback(clientWith([{ deviceId: 'dev_a', publicKey: 'pub_a' }]), send),
        ).rejects.toThrow('needs pro');
        expect(send).toHaveBeenCalledTimes(2);
    });
});
