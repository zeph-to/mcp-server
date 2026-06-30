import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';

// pollForResponse owns the long-poll loop (covered in poll.test.ts). Here we
// mock it so the zeph_ask handler's branching — trigger → poll → shape result
// — is tested in isolation without timers or network.
vi.mock('../poll.js', () => ({ pollForResponse: vi.fn() }));

// Mock crypto so the encrypt/no-encrypt branch is controllable (see
// notify.test.ts). Default to "no keys"; the encrypted test opts in.
vi.mock('../crypto.js', () => ({
    getKeyPair: vi.fn(() => null),
    getPublicKey: vi.fn(() => null),
    encryptPushBodyForSelf: vi.fn(),
    encryptFileForSelf: vi.fn(),
}));

import { pollForResponse } from '../poll.js';
import { registerAskTool } from './ask.js';
import { ApiError, type ZephApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import type { HookEventResponse } from '../types.js';
import { getKeyPair, getPublicKey, encryptFileForSelf } from '../crypto.js';

const mkConfig = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
    apiKey: 'k',
    baseUrl: 'https://api.test',
    projectName: 'proj',
    sessionId: 'sess_1',
    hookId: 'hook_1',
    ...over,
});

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

const polled = vi.mocked(pollForResponse);

const event = (data: HookEventResponse['data']): HookEventResponse => ({ data });

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getKeyPair).mockReturnValue(null);
    vi.mocked(getPublicKey).mockReturnValue(null);
});

describe('registerAskTool', () => {
    it('returns HOOK_NOT_CONFIGURED when no hookId is configured', async () => {
        const client = { triggerHook: vi.fn() } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as ZephApiClient, mkConfig({ hookId: undefined }));

        const result = await run({ title: 'T', timeout: 120, inputType: 'text' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('HOOK_NOT_CONFIGURED');
        expect(client.triggerHook).not.toHaveBeenCalled();
    });

    it('triggers a combo hook, threads the eventId/timeout to the poll, and returns the actionId', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<ZephApiClient>;
        const apiClient = client as unknown as ZephApiClient;
        polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { actionId: 'yes' } }));
        const { server, run } = captureTool();
        registerAskTool(server, apiClient, mkConfig());

        const actions = [
            { id: 'yes', label: 'Yes', style: 'primary' },
            { id: 'no', label: 'No', style: 'secondary' },
        ];
        const result = await run({ title: 'Deploy?', body: 'ship it', actions, inputType: 'text', timeout: 120 });

        expect(client.triggerHook).toHaveBeenCalledWith(
            'hook_1',
            expect.objectContaining({
                title: 'proj · Deploy?',
                body: 'ship it',
                actions,
                hookType: 'combo',
                timeout: 120,
                sessionId: 'sess_1',
            }),
        );
        // Trigger → poll threading: the eventId from the trigger response and
        // the requested timeout must flow into pollForResponse unchanged.
        expect(polled).toHaveBeenCalledWith(apiClient, 'hook_1', 'e1', 120, expect.anything());
        expect(parse(result)).toEqual({ actionId: 'yes', timedOut: false });
    });

    it('returns the typed value when the user submits text', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<ZephApiClient>;
        polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { value: 'typed answer' } }));
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ title: 'Name?', inputType: 'text', timeout: 120 });

        expect(parse(result)).toEqual({ value: 'typed answer', timedOut: false });
    });

    it('recovers actions that leaked into the body of a malformed call', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<ZephApiClient>;
        polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { actionId: 'commit' } }));
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as ZephApiClient, mkConfig());

        const leakedBody =
            'Commit now?</body>\n<parameter name="actions">[{"id":"commit","label":"Commit"},{"id":"test","label":"Test"}]';
        await run({ title: 'Q', body: leakedBody, inputType: 'text', timeout: 120 });

        expect(client.triggerHook).toHaveBeenCalledWith(
            'hook_1',
            expect.objectContaining({
                body: 'Commit now?',
                actions: [
                    { id: 'commit', label: 'Commit' },
                    { id: 'test', label: 'Test' },
                ],
            }),
        );
    });

    it('uploads a plaintext file and truncates the trigger body when the body is long', async () => {
        const longBody = 'y'.repeat(250);
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
            requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'key_1', uploadUrl: 'https://s3/put' } })),
            uploadToS3: vi.fn(async () => undefined),
        } satisfies Partial<ZephApiClient>;
        polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { value: 'ok' } }));
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as ZephApiClient, mkConfig());

        await run({ title: 'Long', body: longBody, inputType: 'multiline', timeout: 120 });

        expect(client.requestUpload).toHaveBeenCalledWith(
            expect.objectContaining({ fileName: 'response.md' }),
        );
        expect(client.uploadToS3).toHaveBeenCalled();
        expect(client.triggerHook).toHaveBeenCalledWith(
            'hook_1',
            expect.objectContaining({
                body: `${'y'.repeat(200)}...`,
                files: [expect.objectContaining({ fileKey: 'key_1', fileName: 'response.md' })],
            }),
        );
    });

    it('encrypts the attached file and populates the file iv/key when keys are available', async () => {
        vi.mocked(getKeyPair).mockReturnValue({} as CryptoKeyPair);
        vi.mocked(getPublicKey).mockReturnValue('my-public-key');
        const ciphertext = Buffer.from('cipherbytes');
        vi.mocked(encryptFileForSelf).mockResolvedValue({ ciphertext, iv: 'FILE_IV', encryptedKey: 'FILE_ENC_KEY' });
        const longBody = 'z'.repeat(250);
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
            requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'key_1', uploadUrl: 'https://s3/put' } })),
            uploadToS3: vi.fn(async () => undefined),
        } satisfies Partial<ZephApiClient>;
        polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { value: 'ok' } }));
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as ZephApiClient, mkConfig());

        await run({ title: 'Long', body: longBody, inputType: 'multiline', timeout: 120 });

        expect(client.requestUpload).toHaveBeenCalledWith(
            expect.objectContaining({ fileType: 'application/octet-stream', fileSize: ciphertext.length }),
        );
        expect(client.uploadToS3).toHaveBeenCalledWith('https://s3/put', ciphertext, 'application/octet-stream');
        expect(client.triggerHook).toHaveBeenCalledWith(
            'hook_1',
            expect.objectContaining({
                files: [expect.objectContaining({ fileKey: 'key_1', iv: 'FILE_IV', encryptedKey: 'FILE_ENC_KEY' })],
            }),
        );
    });

    it('returns the fallback action on timeout when one is supplied', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<ZephApiClient>;
        polled.mockResolvedValue(null);
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ title: 'Q', inputType: 'text', timeout: 120, fallback: 'cancel' });

        expect(parse(result)).toEqual({ actionId: 'cancel', timedOut: true });
    });

    it('returns a TIMEOUT error on timeout with no fallback', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<ZephApiClient>;
        polled.mockResolvedValue(null);
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ title: 'Q', inputType: 'text', timeout: 120 });

        expect(result.isError).toBe(true);
        const body = parse(result);
        expect(body.error).toBe('TIMEOUT');
        expect(body.message).toContain('120 seconds');
    });

    it('formats a triggerHook ApiError into a structured error result', async () => {
        const client = {
            triggerHook: vi.fn(async () => {
                throw new ApiError('disabled', 'HOOK_DISABLED', 400);
            }),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ title: 'Q', inputType: 'text', timeout: 120 });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('HOOK_DISABLED');
    });
});
