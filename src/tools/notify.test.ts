import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';

// Mock crypto so the encrypt/no-encrypt branch is controllable: the real
// getKeyPair()/getPublicKey() only return non-null after initCrypto() has
// talked to the server, which we never do here. Default to "no keys", which
// makes the handler take the plaintext branch before it ever lists devices;
// individual tests opt into the encrypted branch via `withKeys()`.
vi.mock('../crypto.js', () => ({
    getKeyPair: vi.fn(() => null),
    getPublicKey: vi.fn(() => null),
    selectRecipients: vi.fn(() => RECIPIENTS),
    encryptPushBodyForDevices: vi.fn(),
    encryptFileForDevices: vi.fn(),
    disableCrypto: vi.fn(),
}));

const RECIPIENTS = [{ deviceId: 'dev_phone', publicKey: 'phone-pub' }];
const DEVICE_KEY_MAP = { dev_phone: '{"encryptedKey":"WRAPPED","keyIv":"KIV"}' };
const listDevices = vi.fn(async () => ({ data: [{ deviceId: 'dev_phone', publicKey: 'phone-pub' }] }));

/** Put the handler on the encrypted path with a single recipient device. */
const withKeys = () => {
    vi.mocked(getKeyPair).mockReturnValue({} as CryptoKeyPair);
    vi.mocked(getPublicKey).mockReturnValue('my-public-key');
    vi.mocked(encryptPushBodyForDevices).mockResolvedValue({
        body: 'ENC_BODY',
        deviceKeyMap: DEVICE_KEY_MAP,
        senderPublicKey: 'SENDER_PUB',
        isEncrypted: true,
    });
};

import { registerNotifyTool } from './notify.js';
import { ApiError, type ZephApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import { getKeyPair, getPublicKey, encryptPushBodyForDevices } from '../crypto.js';

const mkConfig = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
    apiKey: 'k',
    baseUrl: 'https://api.test',
    projectName: 'proj',
    sessionId: 'sess_1',
    deviceId: 'dev_default',
    ...over,
});

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getKeyPair).mockReturnValue(null);
    vi.mocked(getPublicKey).mockReturnValue(null);
    // Precondition guard for the `encrypted: false` assertions below: with no
    // key material, the handler must take the plaintext branch.
    expect(getKeyPair()).toBeNull();
    expect(getPublicKey()).toBeNull();
});

describe('registerNotifyTool', () => {
    it('sends a short-body push with the formatted title and hook type', async () => {
        const client = {
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_1' } })),
            requestUpload: vi.fn(),
            uploadToS3: vi.fn(),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerNotifyTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ title: 'Build done', body: 'short body', priority: 'normal' });

        expect(client.requestUpload).not.toHaveBeenCalled();
        expect(client.sendPush).toHaveBeenCalledWith({
            title: 'proj · Build done',
            body: 'short body',
            url: undefined,
            type: 'hook',
            priority: 'normal',
            targetDeviceId: 'dev_default',
            sessionId: 'sess_1',
        });
        expect(parse(result)).toEqual({ pushId: 'push_1', encrypted: false });
        expect(result.isError).toBeUndefined();
    });

    it('honors an explicit targetDeviceId over the configured default', async () => {
        const client = {
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_1' } })),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerNotifyTool(server, client as unknown as ZephApiClient, mkConfig());

        await run({ title: 'T', body: 'b', priority: 'high', targetDeviceId: 'dev_explicit' });

        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({ targetDeviceId: 'dev_explicit', priority: 'high' }),
        );
    });

    it('uploads a file and sends a truncated preview when the body exceeds the preview length', async () => {
        const longBody = 'x'.repeat(250);
        const client = {
            requestUpload: vi.fn(async () => ({
                data: { fileId: 'f1', fileKey: 'key_1', uploadUrl: 'https://s3/put' },
            })),
            uploadToS3: vi.fn(async () => undefined),
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_2' } })),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerNotifyTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ title: 'Report', body: longBody, priority: 'normal' });

        expect(client.requestUpload).toHaveBeenCalledWith(
            expect.objectContaining({ fileName: 'response.md', fileSize: expect.any(Number) }),
        );
        expect(client.uploadToS3).toHaveBeenCalledWith(
            'https://s3/put',
            `# Report\n\n${longBody}`,
            expect.any(String),
        );
        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'file',
                body: `${'x'.repeat(200)}...`,
                title: 'proj · Report',
                files: [expect.objectContaining({ fileKey: 'key_1', fileName: 'response.md' })],
                targetDeviceId: 'dev_default',
            }),
        );
        expect(parse(result)).toEqual({
            pushId: 'push_2',
            fileKey: 'key_1',
            autoFile: true,
            encrypted: false,
        });
    });

    it('strips leaked tool-call markup from the body before sending', async () => {
        const client = {
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_3' } })),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerNotifyTool(server, client as unknown as ZephApiClient, mkConfig());

        await run({ title: 'T', body: 'real text</body>\n<parameter name="x">junk', priority: 'normal' });

        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({ body: 'real text' }),
        );
    });

    it('reshapes the push payload into an encrypted envelope when keys are available', async () => {
        withKeys();
        const client = {
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_e' } })),
            listDevices,
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerNotifyTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ title: 'Secret', body: 'classified', priority: 'normal' });

        expect(encryptPushBodyForDevices).toHaveBeenCalledWith(
            { title: 'proj · Secret', body: 'classified', url: undefined },
            RECIPIENTS,
        );
        // title is dropped (would otherwise leak the plaintext) and the body
        // is replaced by the encrypted envelope.
        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({
                title: undefined,
                body: 'ENC_BODY',
                isEncrypted: true,
                deviceKeyMap: DEVICE_KEY_MAP,
                senderPublicKey: 'SENDER_PUB',
            }),
        );
        expect(parse(result)).toEqual({ pushId: 'push_e', encrypted: true });
    });

    it('drops the plaintext url when the push is encrypted', async () => {
        withKeys();
        const client = {
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_u' } })),
            listDevices,
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerNotifyTool(server, client as unknown as ZephApiClient, mkConfig());

        await run({ title: 'Link', body: 'see this', url: 'https://secret.example.com/x', priority: 'normal' });

        // The url is already sealed inside the ciphertext. A plaintext copy at
        // the top level hands the server the one thing isEncrypted promises it
        // cannot see — and on a link push the url IS the payload.
        expect(encryptPushBodyForDevices).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'https://secret.example.com/x' }),
            RECIPIENTS,
        );
        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({ title: undefined, url: undefined, isEncrypted: true }),
        );
    });

    it('keeps the url when the push goes out in the clear', async () => {
        const client = {
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_u2' } })),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerNotifyTool(server, client as unknown as ZephApiClient, mkConfig());

        await run({ title: 'Link', url: 'https://example.com/x', priority: 'normal' });

        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({ url: 'https://example.com/x' }),
        );
    });

    it('formats an ApiError into a structured error result', async () => {
        const client = {
            sendPush: vi.fn(async () => {
                throw new ApiError('over limit', 'QUOTA_EXCEEDED', 403);
            }),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerNotifyTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ title: 'T', body: 'b', priority: 'normal' });

        expect(result.isError).toBe(true);
        const body = parse(result);
        expect(body.error).toBe('QUOTA_EXCEEDED');
        expect(body.suggestion).toMatch(/Upgrade/);
    });
});

// E2E is Pro-only (ADR-0008). The server refuses `isEncrypted` from a free
// account with 403 PRO_REQUIRED — the notification still has to arrive.
describe('registerNotifyTool — PRO_REQUIRED plaintext fallback', () => {
    const quietly = () => {
        withKeys();
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    };

    it('resends the plaintext payload after the encrypted send is refused', async () => {
        quietly();
        const sendPush = vi
            .fn<ZephApiClient['sendPush']>()
            .mockRejectedValueOnce(new ApiError('needs pro', 'PRO_REQUIRED', 403))
            .mockResolvedValueOnce({ data: { pushId: 'push_plain' } } as Awaited<ReturnType<ZephApiClient['sendPush']>>);
        const client = { sendPush, listDevices } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerNotifyTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ title: 'Secret', body: 'classified', priority: 'normal' });

        expect(sendPush).toHaveBeenCalledTimes(2);
        expect(sendPush.mock.calls[0][0].isEncrypted).toBe(true);
        expect(sendPush.mock.calls[1][0]).toEqual({
            title: 'proj · Secret',
            body: 'classified',
            url: undefined,
            type: 'hook',
            priority: 'normal',
            targetDeviceId: 'dev_default',
            sessionId: 'sess_1',
        });
        expect(parse(result)).toEqual({ pushId: 'push_plain', encrypted: false });
        expect(result.isError).toBeUndefined();
    });

    it('surfaces a second PRO_REQUIRED instead of looping', async () => {
        quietly();
        const sendPush = vi
            .fn<ZephApiClient['sendPush']>()
            .mockRejectedValue(new ApiError('needs pro', 'PRO_REQUIRED', 403));
        const client = { sendPush, listDevices } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerNotifyTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ title: 'Secret', body: 'classified', priority: 'normal' });

        expect(sendPush).toHaveBeenCalledTimes(2);
        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('PRO_REQUIRED');
    });
});
