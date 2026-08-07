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
    selectRecipients: vi.fn(() => RECIPIENTS),
    encryptPushBodyForDevices: vi.fn(),
    encryptFileForDevices: vi.fn(),
}));

// Writing the downloaded bytes is response-files.test.ts's job; here only the
// wiring matters — that ask.ts hands the answer's files over and puts the paths
// it gets back into the result.
vi.mock('../response-files.js', async () => {
    const actual = await vi.importActual<typeof import('../response-files.js')>('../response-files.js');
    return { ...actual, saveResponseFiles: vi.fn(async () => []) };
});

import { pollForResponse } from '../poll.js';
import { saveResponseFiles } from '../response-files.js';
import { registerAskTool } from './ask.js';
import { ApiError, type ZephApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import type { HookEventResponse } from '../types.js';
import { getKeyPair, getPublicKey, encryptFileForDevices } from '../crypto.js';

const RECIPIENTS = [{ deviceId: 'dev_phone', publicKey: 'phone-pub' }];
const FILE_KEY_MAP = { dev_phone: '{"encryptedKey":"FILE_WRAPPED","keyIv":"FKIV"}' };
const listDevices = vi.fn(async () => ({ data: [{ deviceId: 'dev_phone', publicKey: 'phone-pub' }] }));

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
    // clearAllMocks keeps implementations, so a test that stubs saved paths
    // would otherwise leak them into every answer after it.
    vi.mocked(saveResponseFiles).mockResolvedValue([]);
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
        expect(polled).toHaveBeenCalledWith(apiClient, 'hook_1', 'e1', 120, expect.anything(), undefined);
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

    it('saves the files the user attached and points the agent at the paths', async () => {
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<ZephApiClient>;
        const files = [{ fileKey: 'files/shot.png', fileName: 'shot.png', fileType: 'image/png', fileSize: 3 }];
        polled.mockResolvedValue(event({
            eventId: 'e1',
            status: 'responded',
            response: { value: 'this screen', files },
        }));
        vi.mocked(saveResponseFiles).mockResolvedValue(['/home/u/.zeph/attachments/hook-e1/shot.png']);
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as ZephApiClient, mkConfig());

        const result = await run({ title: 'What do you see?', inputType: 'text', timeout: 120 });

        expect(saveResponseFiles).toHaveBeenCalledWith(expect.anything(), 'e1', files);
        const parsed = parse(result);
        expect(parsed.value).toBe('this screen');
        expect(parsed.attachments).toEqual(['/home/u/.zeph/attachments/hook-e1/shot.png']);
        // Paths alone read as metadata; the agent has to be told to open them.
        expect(parsed.attachmentsNote).toContain('Read each path');
    });

    it('keeps the attachments when the user taps a button as well', async () => {
        // The button branch returns early — without care it would drop files
        // the same answer carried, and nothing would report the loss.
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
        } satisfies Partial<ZephApiClient>;
        polled.mockResolvedValue(event({
            eventId: 'e1',
            status: 'responded',
            response: {
                actionId: 'broken',
                files: [{ fileKey: 'files/shot.png', fileName: 'shot.png', fileType: 'image/png', fileSize: 3 }],
            },
        }));
        vi.mocked(saveResponseFiles).mockResolvedValue(['/tmp/hook-e1/shot.png']);
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as ZephApiClient, mkConfig());

        const parsed = parse(await run({ title: 'Fixed?', inputType: 'text', timeout: 120 }));

        expect(parsed.actionId).toBe('broken');
        expect(parsed.attachments).toEqual(['/tmp/hook-e1/shot.png']);
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
            listDevices,
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

    // Unlike zeph_notify / zeph_file, this attachment stays plaintext even for
    // an account with E2E on: it rides POST /hooks/:id/trigger, which creates a
    // push with no `isEncrypted` and no `senderPublicKey`, and clients gate
    // decryption on both. Encrypting here ships bytes nothing will open.
    it('leaves the attached file plaintext even when keys are available', async () => {
        vi.mocked(getKeyPair).mockReturnValue({} as CryptoKeyPair);
        vi.mocked(getPublicKey).mockReturnValue('my-public-key');
        const longBody = 'z'.repeat(250);
        const client = {
            triggerHook: vi.fn(async () => ({ data: { pushId: 'p', eventId: 'e1' } })),
            requestUpload: vi.fn(async () => ({ data: { fileId: 'f1', fileKey: 'key_1', uploadUrl: 'https://s3/put' } })),
            uploadToS3: vi.fn(async () => undefined),
            listDevices,
        } satisfies Partial<ZephApiClient>;
        polled.mockResolvedValue(event({ eventId: 'e1', status: 'responded', response: { value: 'ok' } }));
        const { server, run } = captureTool();
        registerAskTool(server, client as unknown as ZephApiClient, mkConfig());

        await run({ title: 'Long', body: longBody, inputType: 'multiline', timeout: 120 });

        expect(client.requestUpload).toHaveBeenCalledWith(
            expect.objectContaining({ fileType: 'text/markdown' }),
        );
        expect(client.uploadToS3).toHaveBeenCalledWith(
            'https://s3/put', expect.stringContaining('# Long'), 'text/markdown',
        );
        expect(client.triggerHook).toHaveBeenCalledWith(
            'hook_1',
            expect.objectContaining({
                // No `iv`, no `deviceKeyMap` — the descriptor carries no
                // encryption fields at all on this path.
                files: [{ fileKey: 'key_1', fileName: 'response.md', fileSize: 258, fileType: 'text/markdown' }],
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
