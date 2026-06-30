import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';
import { registerClipboardTool } from './clipboard.js';
import { ApiError, type ZephApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';

const config: McpServerConfig = {
    apiKey: 'k',
    baseUrl: 'https://api.test',
    projectName: 'proj',
    sessionId: 'sess_1',
    deviceId: 'dev_default',
};

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

describe('registerClipboardTool', () => {
    it('sends a clipboard-type push to the default device', async () => {
        const client = {
            sendPush: vi.fn(async () => ({ data: { pushId: 'pc' } })),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerClipboardTool(server, client as unknown as ZephApiClient, config);

        const result = await run({ text: 'copy me' });

        expect(client.sendPush).toHaveBeenCalledWith({
            title: 'Clipboard',
            body: 'copy me',
            type: 'clipboard',
            targetDeviceId: 'dev_default',
            sessionId: 'sess_1',
        });
        expect(parse(result)).toEqual({ pushId: 'pc' });
    });

    it('routes to an explicit targetDeviceId when given', async () => {
        const client = {
            sendPush: vi.fn(async () => ({ data: { pushId: 'pc' } })),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerClipboardTool(server, client as unknown as ZephApiClient, config);

        await run({ text: 'x', targetDeviceId: 'dev_explicit' });

        expect(client.sendPush).toHaveBeenCalledWith(
            expect.objectContaining({ targetDeviceId: 'dev_explicit' }),
        );
    });

    it('formats an ApiError into a structured error result', async () => {
        const client = {
            sendPush: vi.fn(async () => {
                throw new ApiError('nope', 'UNAUTHORIZED', 401);
            }),
        } satisfies Partial<ZephApiClient>;
        const { server, run } = captureTool();
        registerClipboardTool(server, client as unknown as ZephApiClient, config);

        const result = await run({ text: 'x' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('UNAUTHORIZED');
    });
});
