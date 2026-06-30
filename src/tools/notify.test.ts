import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';

// Mock crypto so the encrypt/no-encrypt branch is controllable: the real
// getKeyPair()/getPublicKey() only return non-null after initCrypto() fetches
// device keys over the network, which we never do here. Default to "no keys"
// (canEncrypt=false); individual tests opt into the encrypted branch.
vi.mock('../crypto.js', () => ({
    getKeyPair: vi.fn(() => null),
    getPublicKey: vi.fn(() => null),
    encryptPushBodyForSelf: vi.fn(),
    encryptFileForSelf: vi.fn(),
}));

import { registerNotifyTool } from './notify.js';
import { ApiError, type ZephApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import { getKeyPair, getPublicKey, encryptPushBodyForSelf } from '../crypto.js';

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
        vi.mocked(getKeyPair).mockReturnValue({} as CryptoKeyPair);
        vi.mocked(getPublicKey).mockReturnValue('my-public-key');
        vi.mocked(encryptPushBodyForSelf).mockResolvedValue({
            body: 'ENC_BODY',
            encryptedKey: 'ENC_KEY',
            senderPublicKey: 'SENDER_PUB',
            isEncrypted: true,
        });
        const client = {
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_e' } })),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerNotifyTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ title: 'Secret', body: 'classified', priority: 'normal' });

        expect(encryptPushBodyForSelf).toHaveBeenCalledWith({
            title: 'proj · Secret',
            body: 'classified',
            url: undefined,
        });
        // title is dropped (would otherwise leak the plaintext) and the body
        // is replaced by the encrypted envelope.
        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({
                title: undefined,
                body: 'ENC_BODY',
                isEncrypted: true,
                encryptedKey: 'ENC_KEY',
                senderPublicKey: 'SENDER_PUB',
            }),
        );
        expect(parse(result)).toEqual({ pushId: 'push_e', encrypted: true });
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
