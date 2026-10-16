import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.js';
import { isSunset, RETIRED_ASK_STATE, SUNSET_DATE, SUNSET_MESSAGE, SUNSET_NOTICE } from './sunset.js';

const BEFORE = new Date('2026-10-31T23:59:59.999Z');
const ON = new Date('2026-11-01T00:00:00.000Z');
const AFTER = new Date('2027-03-01T12:00:00.000Z');

// Valid arguments for every tool, so a call passes the SDK's schema check and
// reaches the handler — the point is that the handler is never run after D.
const VALID_ARGS: Record<string, Record<string, unknown>> = {
    zeph_notify: { title: 't', body: 'b' },
    zeph_file: { fileName: 'a.txt', content: 'x' },
    zeph_clipboard: { text: 'x' },
    zeph_broadcast: { channelId: 'ch_1', title: 't' },
    zeph_list: {},
    zeph_dismiss: { pushId: 'push_1' },
    zeph_dismiss_all: {},
    zeph_ask: { title: 'q', timeout: 600 },
    zeph_agent_send: { target: 'dev:sess', message: 'hi' },
    zeph_session_rename: { alias: 'a' },
};

const config = { apiKey: 'k', baseUrl: 'http://localhost', projectName: 'p', hookId: 'hook_1' };

const clients: Client[] = [];
afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    vi.unstubAllGlobals();
});

const connect = async (now: () => Date) => {
    const server = createServer(config, now);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    clients.push(client);
    return client;
};

const texts = (r: CallToolResult) => r.content.map((c) => (c as { text: string }).text);

describe('isSunset', () => {
    it('flips at 00:00 UTC on the sunset date', () => {
        expect(SUNSET_DATE).toBe('2026-11-01');
        expect(isSunset(BEFORE)).toBe(false);
        expect(isSunset(ON)).toBe(true);
        expect(isSunset(AFTER)).toBe(true);
    });

    it('uses the UTC calendar day, not the local one', () => {
        // 2026-11-01T01:00+09:00 is still 2026-10-31 in UTC.
        expect(isSunset(new Date('2026-11-01T01:00:00+09:00'))).toBe(false);
        // 2026-10-31T20:00-05:00 is already 2026-11-01 in UTC.
        expect(isSunset(new Date('2026-10-31T20:00:00-05:00'))).toBe(true);
    });
});

describe('before the sunset date', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        fetchSpy = vi.fn(async (url: string) => {
            const path = String(url);
            const data = path.includes('/trigger')
                ? { data: { eventId: 'e1' } }
                : path.includes('/events/')
                  ? { data: { status: 'responded', response: { actionId: 'go' } } }
                  : { data: [], pagination: { hasMore: false } };
            return new Response(JSON.stringify(data), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchSpy);
    });

    it('keeps the tool result and appends one notice line', async () => {
        const client = await connect(() => BEFORE);
        const result = (await client.callTool({ name: 'zeph_list', arguments: {} })) as CallToolResult;

        expect(fetchSpy).toHaveBeenCalled();
        expect(result.isError).toBeFalsy();
        const lines = texts(result);
        expect(lines.at(-1)).toBe(SUNSET_NOTICE);
        expect(lines.length).toBe(2);
        expect(JSON.parse(lines[0] as string)).toMatchObject({ total: 0 });
        expect(SUNSET_NOTICE).not.toContain('\n');
    });

    it('lets zeph_ask run as before', async () => {
        const client = await connect(() => BEFORE);
        const result = (await client.callTool({ name: 'zeph_ask', arguments: { title: 'q' } })) as CallToolResult;

        expect(JSON.parse(texts(result)[0] as string)).toMatchObject({ actionId: 'go', timedOut: false });
        expect(texts(result).at(-1)).toBe(SUNSET_NOTICE);
    });

    it('also tags error results', async () => {
        fetchSpy.mockImplementation(async () => new Response('{}', { status: 500 }));
        const client = await connect(() => BEFORE);
        const result = (await client.callTool({ name: 'zeph_list', arguments: {} })) as CallToolResult;

        expect(result.isError).toBe(true);
        expect(texts(result).at(-1)).toBe(SUNSET_NOTICE);
    });

    it('serves resources unchanged', async () => {
        const client = await connect(() => BEFORE);
        const res = await client.readResource({ uri: 'zeph://devices' });
        expect(fetchSpy).toHaveBeenCalled();
        expect((res.contents[0] as { text: string }).text).not.toBe(SUNSET_MESSAGE);
    });
});

describe.each([
    ['started after the date', () => AFTER, undefined],
    ['crossed the date while running', undefined, true],
] as const)('on and after the sunset date (%s)', (_label, fixedClock, crossing) => {
    let fetchSpy: ReturnType<typeof vi.fn>;
    let current: Date;
    beforeEach(() => {
        // A fetch that would hang a poll loop forever if anything reached it.
        fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: { status: 'pending' } }), { status: 200 }));
        vi.stubGlobal('fetch', fetchSpy);
        current = crossing ? BEFORE : AFTER;
    });

    const open = async () => {
        const client = await connect(fixedClock ?? (() => current));
        current = ON; // no-op for the "started after" case
        return client;
    };

    it('registers exactly the known tools', async () => {
        const client = await open();
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(VALID_ARGS).sort());
    });

    it.each(Object.keys(VALID_ARGS))('%s returns the retirement text with no network call', async (name) => {
        const client = await open();
        const result = (await client.callTool({ name, arguments: VALID_ARGS[name] })) as CallToolResult;

        expect(result.isError).toBe(false);
        expect(texts(result)).toEqual(name === 'zeph_ask' ? [RETIRED_ASK_STATE, SUNSET_MESSAGE] : [SUNSET_MESSAGE]);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('zeph_ask returns at once instead of waiting for an answer', async () => {
        const client = await open();
        const started = Date.now();
        const result = (await client.callTool({ name: 'zeph_ask', arguments: { title: 'q', timeout: 600 } })) as CallToolResult;

        expect(Date.now() - started).toBeLessThan(1000);
        expect(texts(result)).toEqual([RETIRED_ASK_STATE, SUNSET_MESSAGE]);
        expect(JSON.parse(RETIRED_ASK_STATE)).toEqual({ answered: false, timedOut: false, zephState: 'NORMAL' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each(['zeph://devices', 'zeph://channels'])('%s returns the retirement text with no network call', async (uri) => {
        const client = await open();
        const res = await client.readResource({ uri });

        expect(res.contents).toEqual([{ uri, text: SUNSET_MESSAGE }]);
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

describe('server started after the sunset date', () => {
    it('answers any arguments, even ones the old schema would reject', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const client = await connect(() => AFTER);

        const result = (await client.callTool({ name: 'zeph_notify', arguments: {} })) as CallToolResult;

        expect(result.isError).toBe(false);
        expect(texts(result)).toEqual([SUNSET_MESSAGE]);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('states the retirement in its instructions', async () => {
        const client = await connect(() => AFTER);
        expect(client.getInstructions()).toBe(SUNSET_MESSAGE);
    });
});
