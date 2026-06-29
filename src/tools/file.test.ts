import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';

// Mock crypto so the encrypt/no-encrypt branch is controllable (see
// notify.test.ts for the rationale). Default to "no keys"; the encrypted
// test opts in.
vi.mock('../crypto.js', () => ({
    getKeyPair: vi.fn(() => null),
    getPublicKey: vi.fn(() => null),
    encryptPushBodyForSelf: vi.fn(),
    encryptFileForSelf: vi.fn(),
}));

import { registerFileTool } from './file.js';
import { ApiError, type ZephApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import { getKeyPair, getPublicKey, encryptPushBodyForSelf, encryptFileForSelf } from '../crypto.js';

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
        expect(parse(result)).toEqual({ pushId: 'push_f', fileKey: 'fk_1', fileSize: 11, encrypted: false });
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
        vi.mocked(encryptFileForSelf).mockResolvedValue({ ciphertext, iv: 'FILE_IV', encryptedKey: 'FILE_ENC_KEY' });
        vi.mocked(encryptPushBodyForSelf).mockResolvedValue({
            body: 'ENC_BODY',
            encryptedKey: 'PUSH_ENC_KEY',
            senderPublicKey: 'SENDER_PUB',
            isEncrypted: true,
        });
        const client = {
            requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'fk_1', uploadUrl: 'https://s3/up' } })),
            uploadToS3: vi.fn(async () => undefined),
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_e' } })),
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
                encryptedKey: 'PUSH_ENC_KEY',
                senderPublicKey: 'SENDER_PUB',
                files: [expect.objectContaining({ fileKey: 'fk_1', iv: 'FILE_IV', encryptedKey: 'FILE_ENC_KEY' })],
            }),
        );
        expect(parse(result)).toEqual({ pushId: 'push_e', fileKey: 'fk_1', fileSize: 5, encrypted: true });
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
