import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.js';

// Drives the real server over an in-memory MCP transport — what a client sees
// on connect is exactly what lands in the agent's context, so this is where the
// tool surface and its token cost are locked.
const clients: Client[] = [];

afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
});

const connect = async () => {
    const server = createServer({ apiKey: 'k', baseUrl: 'http://localhost', projectName: 'p' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    clients.push(client);
    return client;
};

describe('createServer', () => {
    it('exposes zeph_ask as the only interactive tool', async () => {
        const client = await connect();
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
            'zeph_agent_send',
            'zeph_ask',
            'zeph_broadcast',
            'zeph_clipboard',
            'zeph_dismiss',
            'zeph_dismiss_all',
            'zeph_file',
            'zeph_list',
            'zeph_notify',
            'zeph_session_rename',
        ]);
    });

    it('keeps the always-loaded instructions short and free of a tool list', async () => {
        const client = await connect();
        const instructions = client.getInstructions() ?? '';
        expect(instructions).toContain('zeph_ask');
        expect(instructions).not.toContain('zeph_clipboard');
        expect(instructions.length).toBeLessThanOrEqual(400);
    });

    it('states the zeph_ask actions rule in full once, in the actions field', async () => {
        const client = await connect();
        const { tools } = await client.listTools();
        const ask = tools.find((t) => t.name === 'zeph_ask');
        const actions = ask?.inputSchema.properties?.actions as { description?: string } | undefined; // JSON Schema property; the SDK types it as unknown
        expect(actions?.description).toContain('Omit ONLY');
        expect(ask?.description).not.toContain('Omit ONLY');
        expect(ask?.description).toContain('`actions`');
        expect(ask?.description?.length).toBeLessThanOrEqual(500);
        expect(ask?.description).toContain('end-to-end encrypted');
        expect(ask?.description).toContain('attachments');
    });
});
