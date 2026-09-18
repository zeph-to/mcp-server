import { describe, it, expect, vi, beforeEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';

// Mock crypto so the encrypt/no-encrypt branch is controllable (see
// notify.test.ts for the rationale). Default to "no keys"; the encrypted
// test opts in.
vi.mock('../crypto.js', () => ({
    getKeyPair: vi.fn(() => null),
    getPublicKey: vi.fn(() => null),
    selectRecipients: vi.fn(() => RECIPIENTS),
    encryptPushBodyForDevices: vi.fn(),
    encryptFileForDevices: vi.fn(),
    disablePushEncryption: vi.fn(),
    isPushEncryptionEnabled: vi.fn(() => true),
}));

import { registerFileTool } from './file.js';
import { ApiError, type ZephApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import { getKeyPair, getPublicKey, encryptPushBodyForDevices, encryptFileForDevices } from '../crypto.js';

const RECIPIENTS = [{ deviceId: 'dev_phone', publicKey: 'phone-pub' }];
const FILE_KEY_MAP = { dev_phone: '{"encryptedKey":"FILE_WRAPPED","keyIv":"FKIV"}' };
const PUSH_KEY_MAP = { dev_phone: '{"encryptedKey":"PUSH_WRAPPED","keyIv":"PKIV"}' };
const listDevices = vi.fn(async () => ({ data: [{ deviceId: 'dev_phone', publicKey: 'phone-pub' }] }));

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
    // Precondition guard for the `encrypted: false` assertions: no key material
    // means the handler must upload plaintext.
    expect(getKeyPair()).toBeNull();
    expect(getPublicKey()).toBeNull();
});

describe('registerFileTool', () => {
    it('requests an upload URL, uploads content, then sends a file push', async () => {
        const client = {
            requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'fk_1', uploadUrl: 'https://s3/up' } })),
            uploadToS3: vi.fn(async () => undefined),
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_f' } })),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerFileTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ fileName: 'report.txt', content: 'hello world' });

        expect(client.requestUpload).toHaveBeenCalledWith(
            expect.objectContaining({ fileName: 'report.txt', fileSize: 11 }),
        );
        expect(client.uploadToS3).toHaveBeenCalledWith('https://s3/up', 'hello world', expect.any(String));
        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'proj · report.txt',
                type: 'file',
                files: [expect.objectContaining({ fileKey: 'fk_1', fileName: 'report.txt', fileSize: 11 })],
                targetDeviceId: 'dev_default',
                sessionId: 'sess_1',
            }),
        );
        expect(parse(result)).toEqual({ pushId: 'push_f', fileKey: 'fk_1', fileSize: 11, encrypted: false, delivery: 'Sent via cloud' });
    });

    it('uses an explicit title when provided', async () => {
        const client = {
            requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'fk_1', uploadUrl: 'https://s3/up' } })),
            uploadToS3: vi.fn(async () => undefined),
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_f' } })),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerFileTool(server, client as unknown as ZephApiClient, mkConfig());

        await run({ fileName: 'log.txt', content: 'x', title: 'Crash log' });

        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({ title: 'proj · Crash log' }),
        );
    });

    it('encrypts the content and reshapes the push when keys are available', async () => {
        vi.mocked(getKeyPair).mockReturnValue({} as CryptoKeyPair);
        vi.mocked(getPublicKey).mockReturnValue('my-public-key');
        const ciphertext = Buffer.from('cipherbytes');
        vi.mocked(encryptFileForDevices).mockResolvedValue({ ciphertext, iv: 'FILE_IV', deviceKeyMap: FILE_KEY_MAP });
        vi.mocked(encryptPushBodyForDevices).mockResolvedValue({
            body: 'ENC_BODY',
            deviceKeyMap: PUSH_KEY_MAP,
            senderPublicKey: 'SENDER_PUB',
            isEncrypted: true,
        });
        const client = {
            requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'fk_1', uploadUrl: 'https://s3/up' } })),
            uploadToS3: vi.fn(async () => undefined),
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_e' } })),
            listDevices,
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerFileTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ fileName: 'report.txt', content: 'hello' });

        // The uploaded blob is the ciphertext as opaque bytes.
        expect(client.requestUpload).toHaveBeenCalledWith(
            expect.objectContaining({
                fileName: 'report.txt',
                fileType: 'application/octet-stream',
                fileSize: ciphertext.length,
            }),
        );
        expect(client.uploadToS3).toHaveBeenCalledWith('https://s3/up', ciphertext, 'application/octet-stream');
        // The file descriptor carries the per-file iv + wrapped key; the push
        // body becomes the encrypted envelope and the plaintext title is dropped.
        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({
                title: undefined,
                body: 'ENC_BODY',
                isEncrypted: true,
                deviceKeyMap: PUSH_KEY_MAP,
                senderPublicKey: 'SENDER_PUB',
                files: [expect.objectContaining({ fileKey: 'fk_1', iv: 'FILE_IV', deviceKeyMap: FILE_KEY_MAP })],
            }),
        );
        expect(parse(result)).toEqual({ pushId: 'push_e', fileKey: 'fk_1', fileSize: 5, encrypted: true, delivery: 'Sent via cloud' });
    });

    it('does not send a push when the S3 upload fails', async () => {
        const client = {
            requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'fk_1', uploadUrl: 'https://s3/up' } })),
            uploadToS3: vi.fn(async () => {
                throw new ApiError('S3 upload failed with status 500', 'UPLOAD_FAILED', 500);
            }),
            sendPush: vi.fn(),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerFileTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ fileName: 'report.txt', content: 'hello' });

        expect(client.sendPush).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('UPLOAD_FAILED');
    });

    it('does not upload or push when requesting the upload URL fails', async () => {
        const client = {
            requestUpload: vi.fn(async () => {
                throw new ApiError('forbidden', 'FORBIDDEN', 403);
            }),
            uploadToS3: vi.fn(),
            sendPush: vi.fn(),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerFileTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ fileName: 'report.txt', content: 'hello' });

        expect(client.uploadToS3).not.toHaveBeenCalled();
        expect(client.sendPush).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('FORBIDDEN');
    });
});

// Binary attachments (screenshots, PDFs) have to reach the device as bytes with
// their real mime type — the clients pick the image viewer off
// `fileType`/extension.
describe('registerFileTool — binary attachments', () => {
    it('uploads a local image as its own bytes under an image mime type', async () => {
        const client = {
            requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'fk_1', uploadUrl: 'https://s3/up' } })),
            uploadToS3: vi.fn(async () => undefined),
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_img' } })),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerFileTool(server, client as unknown as ZephApiClient, mkConfig());

        // A 1x1 PNG on disk — the shape an agent actually holds.
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
        );
        const filePath = join(tmpdir(), 'zeph-test-1x1.png');
        writeFileSync(filePath, png);

        await run({ filePath });

        expect(client.requestUpload).toHaveBeenCalledWith(
            expect.objectContaining({ fileName: 'zeph-test-1x1.png', fileType: 'image/png', fileSize: png.length }),
        );
        expect(client.uploadToS3).toHaveBeenCalledWith('https://s3/up', png, 'image/png');
        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({
                files: [expect.objectContaining({ fileName: 'zeph-test-1x1.png', fileType: 'image/png', fileSize: png.length })],
            }),
        );
    });

    it('rejects a call with neither filePath nor content', async () => {
        const client = { requestUpload: vi.fn(), uploadToS3: vi.fn(), sendPush: vi.fn() } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerFileTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ title: 'nothing to send' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('INVALID_INPUT');
        expect(client.requestUpload).not.toHaveBeenCalled();
    });

    it('reports an unreadable filePath instead of pushing', async () => {
        const client = { requestUpload: vi.fn(), uploadToS3: vi.fn(), sendPush: vi.fn() } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerFileTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ filePath: join(tmpdir(), 'zeph-does-not-exist-9f3a.png') });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('FILE_READ_FAILED');
        expect(client.sendPush).not.toHaveBeenCalled();
    });
});

// E2E is Pro-only (ADR-0008). A refused encrypted send must not leave the file
// in S3 as an undecryptable blob — the retry re-uploads it as plaintext.
describe('registerFileTool — PRO_REQUIRED plaintext fallback', () => {
    it('re-uploads the content unencrypted and resends', async () => {
        vi.mocked(getKeyPair).mockReturnValue({} as CryptoKeyPair);
        vi.mocked(getPublicKey).mockReturnValue('my-public-key');
        vi.mocked(encryptFileForDevices).mockResolvedValue({
            ciphertext: Buffer.from('cipherbytes'),
            iv: 'FILE_IV',
            deviceKeyMap: FILE_KEY_MAP,
        });
        vi.mocked(encryptPushBodyForDevices).mockResolvedValue({
            body: 'ENC_BODY',
            deviceKeyMap: PUSH_KEY_MAP,
            senderPublicKey: 'SENDER_PUB',
            isEncrypted: true,
        });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const sendPush = vi
            .fn<ZephApiClient['sendPush']>()
            .mockRejectedValueOnce(new ApiError('needs pro', 'PRO_REQUIRED', 403))
            .mockResolvedValueOnce({ data: { pushId: 'push_plain' } } as Awaited<ReturnType<ZephApiClient['sendPush']>>);
        const client = {
            requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'fk_1', uploadUrl: 'https://s3/up' } })),
            uploadToS3: vi.fn(async () => undefined),
            sendPush,
            listDevices,
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerFileTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ fileName: 'report.txt', content: 'hello' });

        expect(client.requestUpload).toHaveBeenCalledTimes(2);
        expect(client.uploadToS3).toHaveBeenCalledTimes(2);
        // Second upload carries the raw text under the file's own mime type.
        expect(client.uploadToS3.mock.calls[1][1]).toBe('hello');
        expect(client.uploadToS3.mock.calls[1][2]).toBe('text/plain');
        const retried = sendPush.mock.calls[1][0];
        expect(retried.isEncrypted).toBeUndefined();
        expect(retried.title).toBe('proj · report.txt');
        expect(retried.files?.[0].iv).toBeUndefined();
        expect(retried.files?.[0].deviceKeyMap).toBeUndefined();
        expect(parse(result)).toEqual({ pushId: 'push_plain', fileKey: 'fk_1', fileSize: 5, encrypted: false, delivery: 'Sent via cloud' });
    });
});

/**
 * The agent-side sender relays, always.
 *
 * It used to hand a file straight to a target on the same network (ADR-0013),
 * which meant an agent writing a file put it on the user's disk without the
 * user asking for that. The direct route now belongs to the share sheets,
 * where a person picks it; from here every file goes through the cloud, where
 * it stays fetchable by every device on the account.
 */
describe('registerFileTool — the agent sender never goes direct', () => {
    it('uploads and relays even when the target is reachable on this network', async () => {
        vi.mocked(getKeyPair).mockReturnValue({} as CryptoKeyPair);
        vi.mocked(getPublicKey).mockReturnValue('my-public-key');
        vi.mocked(encryptFileForDevices).mockResolvedValue({ ciphertext: Buffer.from('cipherbytes'), iv: 'FILE_IV', deviceKeyMap: FILE_KEY_MAP });
        vi.mocked(encryptPushBodyForDevices).mockResolvedValue({ body: 'ENC_BODY', deviceKeyMap: PUSH_KEY_MAP, senderPublicKey: 'SENDER_PUB', isEncrypted: true });
        // A target that would have passed every old precondition: online, keyed,
        // with a published endpoint, and a sender whose key is the registered one.
        const phone = { deviceId: 'dev_phone', nickname: 'Pixel', publicKey: 'phone-pub', isOnline: true, lan: { host: '192.168.1.20', port: 51234 } };
        const client = {
            requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'fk_1', uploadUrl: 'https://s3/up' } })),
            uploadToS3: vi.fn(async () => undefined),
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_1' } })),
            listDevices: vi.fn(async () => ({ data: [phone, { deviceId: 'dev_listener_me', publicKey: 'my-public-key' }] })),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerFileTool(server, client as unknown as ZephApiClient, mkConfig({ deviceId: 'dev_phone', agentDeviceId: 'dev_listener_me' }));

        const result = await run({ fileName: 'report.txt', content: 'hello' });

        expect(client.requestUpload).toHaveBeenCalledTimes(1);
        expect(client.uploadToS3).toHaveBeenCalledTimes(1);
        const push = vi.mocked(client.sendPush).mock.calls[0][0] as { files: Record<string, unknown>[] };
        expect(push.files[0].fileKey).toBe('fk_1');
        expect(push.files[0]).not.toHaveProperty('lanDeliveredTo');
        expect(push.files[0]).not.toHaveProperty('transferId');
        expect(parse(result).delivery).toBe('Sent via cloud');
    });
});
