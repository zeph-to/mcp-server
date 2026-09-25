import { describe, it, expect, vi } from 'vitest';
import { hostname } from 'os';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { captureTool } from '../test-helpers.js';
import { registerAgentSendTool } from './agent-send.js';
import { ApiError, type ZephApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import type { DeviceRecord } from '../types.js';

const config: McpServerConfig = {
    apiKey: 'k',
    baseUrl: 'https://api.test',
    projectName: 'proj',
    deviceId: 'dev_default',
    agentDeviceId: 'dev_mac',
    agentSessionName: 'zeph-proj',
};

const devices: DeviceRecord[] = [
    {
        deviceId: 'dev_mac',
        nickname: 'takPC',
        agentSessions: [{ name: 'zeph-proj' }, { name: 'zeph-brain' }],
        agentSessionAliases: { 'zeph-proj': 'deploy' },
    },
    { deviceId: 'dev_linux', nickname: 'louis-lemon', agentSessions: [{ name: 'zeph-brain' }] },
];

const parse = (r: CallToolResult) => JSON.parse((r.content[0] as { text: string }).text);

const setup = (over: Partial<McpServerConfig> = {}, list: DeviceRecord[] = devices) => {
    const client = {
        listDevices: vi.fn(async () => ({ data: list })),
        sendPush: vi.fn(async (_params: Parameters<ZephApiClient['sendPush']>[0]) => ({ data: { pushId: 'push_1' } })),
    } satisfies Pick<ZephApiClient, 'listDevices' | 'sendPush'>;
    const { server, run } = captureTool();
    registerAgentSendTool(server, client, { ...config, ...over });
    return { client, run };
};

describe('zeph_agent_send', () => {
    it('types the message into the target session, headed by who sent it and where to reply', async () => {
        const { client, run } = setup();

        const result = await run({ target: 'dev_linux:zeph-brain', message: '빌드 로그 확인해줘' });

        expect(client.sendPush).toHaveBeenCalledWith({
            type: 'agent.command',
            targetDeviceId: 'dev_linux',
            agentSessionName: 'zeph-brain',
            body: '[from deploy@takPC · reply: dev_mac:zeph-proj] 빌드 로그 확인해줘',
        });
        expect(parse(result)).toEqual({ sent: true, target: 'dev_linux:zeph-brain', pushId: 'push_1' });
    });

    // agentDeviceId would file the push under a chat that is not the target's;
    // an encrypted agent.command is dropped by the target's listener.
    it('sends plaintext with no agentDeviceId', async () => {
        const { client, run } = setup();

        await run({ target: 'dev_linux:zeph-brain', message: 'hi' });

        const payload = client.sendPush.mock.calls[0][0];
        expect(payload).not.toHaveProperty('agentDeviceId');
        expect(payload).not.toHaveProperty('isEncrypted');
        expect(payload).not.toHaveProperty('deviceKeyMap');
    });

    it('names the machine by its hostname when the device has no nickname', async () => {
        const { client, run } = setup({}, [{ ...devices[0], nickname: undefined }, devices[1]]);

        await run({ target: 'dev_linux:zeph-brain', message: 'hi' });

        expect(client.sendPush.mock.calls[0][0].body).toBe(
            `[from deploy@${hostname()} · reply: dev_mac:zeph-proj] hi`,
        );
    });

    it('drops the reply key outside a tmux session — there is nothing to reply to', async () => {
        const { client, run } = setup({ agentDeviceId: undefined, agentSessionName: undefined });

        await run({ target: 'dev_linux:zeph-brain', message: 'hi' });

        expect(client.sendPush.mock.calls[0][0].body).toBe(`[from proj@${hostname()}] hi`);
    });

    it('refuses to send to itself', async () => {
        const { client, run } = setup();

        const result = await run({ target: 'deploy', message: 'hi' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('SELF_TARGET');
        expect(client.sendPush).not.toHaveBeenCalled();
    });

    it('refuses its own exact key', async () => {
        const { client, run } = setup();

        const result = await run({ target: 'dev_mac:zeph-proj', message: 'hi' });

        expect(parse(result).error).toBe('SELF_TARGET');
        expect(client.sendPush).not.toHaveBeenCalled();
    });

    it('reports an unknown or offline target as a tool error, and sends nothing', async () => {
        const away = devices.map((d) => (d.deviceId === 'dev_linux' ? { ...d, isOnline: false } : d));
        const { client, run } = setup({}, away);

        const unknown = await run({ target: 'nothing-like-this', message: 'hi' });
        const offline = await run({ target: 'dev_linux:zeph-brain', message: 'hi' });

        expect(unknown.isError && parse(unknown).error).toBe('UNKNOWN_TARGET');
        expect(offline.isError && parse(offline).error).toBe('TARGET_OFFLINE');
        expect(client.sendPush).not.toHaveBeenCalled();
    });

    it('returns the candidate keys when the name is ambiguous, and sends nothing', async () => {
        const { client, run } = setup();

        const result = await run({ target: 'zeph-brain', message: 'hi' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('AMBIGUOUS_TARGET');
        expect(parse(result).message).toContain('dev_linux:zeph-brain');
        expect(client.sendPush).not.toHaveBeenCalled();
    });

    it('reports the daily push quota as a tool error', async () => {
        const { client, run } = setup();
        client.sendPush.mockRejectedValueOnce(new ApiError('Daily push limit reached', 'QUOTA_EXCEEDED', 429));

        const result = await run({ target: 'dev_linux:zeph-brain', message: 'hi' });

        expect(result.isError).toBe(true);
        expect(parse(result).error).toBe('QUOTA_EXCEEDED');
    });

    it('signs with the tmux name when the session has no alias', async () => {
        const { client, run } = setup({}, [{ ...devices[0], agentSessionAliases: undefined }, devices[1]]);

        await run({ target: 'dev_linux:zeph-brain', message: 'hi' });

        expect(client.sendPush.mock.calls[0][0].body).toBe('[from zeph-proj@takPC · reply: dev_mac:zeph-proj] hi');
    });

    // A tmux session the listener does not report has no key anyone could answer on.
    it('offers no reply key from a session the listener does not report', async () => {
        const { client, run } = setup({ agentSessionName: 'scratch' });

        await run({ target: 'dev_linux:zeph-brain', message: 'hi' });

        expect(client.sendPush.mock.calls[0][0].body).toBe('[from scratch@takPC] hi');
    });

    // A pi subagent pane names itself `<#S>.<pane>`; replies only resolve to top-level sessions.
    it('offers no reply key from a subagent', async () => {
        const withSubagent = [
            { ...devices[0], agentSessions: [...(devices[0].agentSessions ?? []), { name: 'zeph-proj.2', parentName: 'zeph-proj' }] },
            devices[1],
        ];
        const { client, run } = setup({ agentSessionName: 'zeph-proj.2' }, withSubagent);

        await run({ target: 'dev_linux:zeph-brain', message: 'hi' });

        expect(client.sendPush.mock.calls[0][0].body).toBe('[from zeph-proj.2@takPC] hi');
    });

    // The same project on two PCs: from one of them, its name means the other.
    it('reads a name it shares with the target as the other machine’s session', async () => {
        const { client, run } = setup({ agentSessionName: 'zeph-brain' });

        const result = await run({ target: 'zeph-brain', message: 'hi' });

        expect(parse(result).target).toBe('dev_linux:zeph-brain');
        expect(client.sendPush).toHaveBeenCalledTimes(1);
    });
});
