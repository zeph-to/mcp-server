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
    disableCrypto: vi.fn(),
    deriveLanSharedSecret: vi.fn(),
}));
// The wire half has its own integration test in the cli (real receiver, real
// keys); here only what the tool does with its answer.
vi.mock('../lan-sender.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lan-sender.js')>()),
    tryLanDelivery: vi.fn(),
}));

import { registerFileTool } from './file.js';
import { ApiError, type ZephApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import { getKeyPair, getPublicKey, encryptPushBodyForDevices, encryptFileForDevices } from '../crypto.js';
import { tryLanDelivery } from '../lan-sender.js';

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

describe('registerFileTool — local transfer', () => {
    const SELF = 'dev_listener_me';
    const phone = { deviceId: 'dev_phone', nickname: 'Pixel', publicKey: 'phone-pub', isOnline: true, lan: { host: '192.168.1.20', port: 51234 } };
    const self = { deviceId: SELF, publicKey: 'my-public-key' };
    const ciphertext = Buffer.from('cipherbytes');

    const setup = (devices: object[], config: Partial<McpServerConfig> = {}) => {
        vi.mocked(getKeyPair).mockReturnValue({} as CryptoKeyPair);
        vi.mocked(getPublicKey).mockReturnValue('my-public-key');
        vi.mocked(encryptFileForDevices).mockResolvedValue({ ciphertext, iv: 'FILE_IV', deviceKeyMap: FILE_KEY_MAP });
        vi.mocked(encryptPushBodyForDevices).mockResolvedValue({ body: 'ENC_BODY', deviceKeyMap: PUSH_KEY_MAP, senderPublicKey: 'SENDER_PUB', isEncrypted: true });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const client = {
            requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'fk_1', uploadUrl: 'https://s3/up' } })),
            uploadToS3: vi.fn(async () => undefined),
            sendPush: vi.fn(async () => ({ data: { pushId: 'push_lan' } })),
            listDevices: vi.fn(async () => ({ data: devices })),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerFileTool(server, client as unknown as ZephApiClient, mkConfig({ deviceId: 'dev_phone', agentDeviceId: SELF, ...config }));
        return { client, run };
    };

    it('delivered over the LAN: no upload request, no S3, a push with lanDeliveredTo and no fileKey', async () => {
        vi.mocked(tryLanDelivery).mockResolvedValue({ delivered: true, transferId: 'lt_abc' });
        const { client, run } = setup([phone, self]);

        const result = await run({ fileName: 'report.txt', content: 'hello' });

        expect(tryLanDelivery).toHaveBeenCalledWith(expect.objectContaining({
            target: { deviceId: 'dev_phone', publicKey: 'phone-pub', host: '192.168.1.20', port: 51234 },
            senderDeviceId: SELF,
            file: expect.objectContaining({ fileName: 'report.txt', fileSize: 5, iv: 'FILE_IV', deviceKeyMap: FILE_KEY_MAP, ciphertext }),
        }));
        expect(client.requestUpload).not.toHaveBeenCalled();
        expect(client.uploadToS3).not.toHaveBeenCalled();
        const push = vi.mocked(client.sendPush).mock.calls[0][0];
        expect(push).toEqual(expect.objectContaining({ type: 'file', targetDeviceId: 'dev_phone', isEncrypted: true, body: 'ENC_BODY' }));
        expect(push.files).toEqual([{
            fileName: 'report.txt', fileSize: 5, fileType: 'text/plain', iv: 'FILE_IV', deviceKeyMap: FILE_KEY_MAP,
            lanDeliveredTo: 'dev_phone', transferId: 'lt_abc',
        }]);
        expect(parse(result)).toEqual({ pushId: 'push_lan', fileSize: 5, encrypted: true, delivery: 'Sent locally to Pixel' });
    });

    it('a local transfer that fails goes by relay, and says why in the log', async () => {
        vi.mocked(tryLanDelivery).mockResolvedValue({ delivered: false, reason: 'ping failed: timed out' });
        const { client, run } = setup([phone, self]);

        const result = await run({ fileName: 'report.txt', content: 'hello' });

        expect(client.uploadToS3).toHaveBeenCalledWith('https://s3/up', ciphertext, 'application/octet-stream');
        expect(vi.mocked(client.sendPush).mock.calls[0][0].files).toEqual([expect.objectContaining({ fileKey: 'fk_1' })]);
        expect(parse(result)).toEqual(expect.objectContaining({ delivery: 'Sent via cloud' }));
        expect(console.error).toHaveBeenCalledWith('[LAN] dev_phone: ping failed: timed out — sending via cloud');
    });

    it('never tries — silently — when the send is not eligible', async () => {
        // No listener has registered this host's key: the receiver would only answer 401.
        await setup([phone, { deviceId: SELF }]).run({ fileName: 'a.txt', content: 'x' });
        await setup([phone, { ...self, publicKey: 'someone-elses-key' }]).run({ fileName: 'a.txt', content: 'x' });
        // A broadcast has no single target.
        await setup([phone, self], { deviceId: undefined }).run({ fileName: 'a.txt', content: 'x' });
        // The target has no endpoint, or is offline.
        await setup([{ ...phone, lan: null }, self]).run({ fileName: 'a.txt', content: 'x' });
        await setup([{ ...phone, isOnline: false }, self]).run({ fileName: 'a.txt', content: 'x' });
        expect(tryLanDelivery).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('[LAN]'));
    });

    it('passes the tool call\'s cancel signal to the transfer, and a cancelled call sends nothing by relay', async () => {
        const controller = new AbortController();
        vi.mocked(tryLanDelivery).mockImplementation(async () => { controller.abort(); return { delivered: false, reason: 'cancelled' }; });
        const { client, run } = setup([phone, self]);

        const result = await run({ fileName: 'report.txt', content: 'hello' }, { sendNotification: vi.fn(), signal: controller.signal });

        expect(vi.mocked(tryLanDelivery).mock.calls[0][0].signal).toBe(controller.signal);
        expect(client.requestUpload).not.toHaveBeenCalled();
        expect(client.sendPush).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
    });

    it('delivered locally, then PRO_REQUIRED on the push: resent as plaintext by relay, not tried locally again', async () => {
        vi.mocked(tryLanDelivery).mockResolvedValue({ delivered: true, transferId: 'lt_abc' });
        const { client, run } = setup([phone, self]);
        vi.mocked(client.sendPush)
            .mockRejectedValueOnce(new ApiError('needs pro', 'PRO_REQUIRED', 403))
            .mockResolvedValueOnce({ data: { pushId: 'push_plain' } });

        const result = await run({ fileName: 'report.txt', content: 'hello' });

        expect(tryLanDelivery).toHaveBeenCalledTimes(1);
        expect(client.uploadToS3).toHaveBeenCalledWith('https://s3/up', 'hello', 'text/plain');
        const retried = vi.mocked(client.sendPush).mock.calls[1][0];
        expect(retried.isEncrypted).toBeUndefined();
        expect(retried.files).toEqual([expect.objectContaining({ fileKey: 'fk_1' })]);
        expect(parse(result)).toEqual({ pushId: 'push_plain', fileKey: 'fk_1', fileSize: 5, encrypted: false, delivery: 'Sent via cloud' });
    });

    it('a plaintext send (no keys, e.g. a free account) never tries', async () => {
        const { client, run } = setup([phone, self]);
        vi.mocked(getKeyPair).mockReturnValue(null);
        vi.mocked(getPublicKey).mockReturnValue(null);

        await run({ fileName: 'a.txt', content: 'x' });

        expect(tryLanDelivery).not.toHaveBeenCalled();
        expect(client.listDevices).not.toHaveBeenCalled();
        expect(client.uploadToS3).toHaveBeenCalled();
    });
});
