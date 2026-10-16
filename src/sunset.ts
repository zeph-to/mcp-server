import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

/** Calendar day (UTC) on which this server stops doing anything. */
export const SUNSET_DATE = '2026-11-01';

/** Appended to every tool result before the sunset date. */
export const SUNSET_NOTICE = `Zeph's MCP server is retired on ${SUNSET_DATE}; after that its tools stop working.`;

/** Returned by every tool and resource from the sunset date on. */
export const SUNSET_MESSAGE = `Zeph's MCP server was retired on ${SUNSET_DATE}. Remove it from your MCP configuration.`;

export type Clock = () => Date;

/** True from 00:00 UTC on the sunset date onward (the day itself counts as ended). */
export const isSunset = (now: Date): boolean => now.toISOString().slice(0, 10) >= SUNSET_DATE;

/**
 * zeph_ask also says `zephState: NORMAL`, so an agent left in sticky REMOTE stops
 * ending every turn with a question nobody can answer.
 */
export const RETIRED_ASK_STATE = JSON.stringify({ answered: false, timedOut: false, zephState: 'NORMAL' });

const retiredToolResult = (name: string): CallToolResult => ({
    content: [
        ...(name === 'zeph_ask' ? [{ type: 'text' as const, text: RETIRED_ASK_STATE }] : []),
        { type: 'text', text: SUNSET_MESSAGE },
    ],
    isError: false,
});

const retiredResource = (uri: URL): ReadResourceResult => ({
    contents: [{ uri: uri.href, text: SUNSET_MESSAGE }],
});

type ToolCallback = (...args: unknown[]) => Promise<CallToolResult> | CallToolResult;
type ResourceCallback = (uri: URL, ...rest: unknown[]) => Promise<ReadResourceResult> | ReadResourceResult;
type ToolConfig = { title?: string; description?: string };

/**
 * The single choke point for the sunset: patches `registerTool` and
 * `registerResource` on the server so every handler registered afterwards —
 * whichever module registers it — is wrapped. Call it before any registration.
 *
 * The clock is read on each call, not once, so a server that started before the
 * sunset date and keeps running across it still flips over.
 *
 * Tools registered once the date has passed also drop their input schema: the
 * SDK validates arguments before the handler runs, and an agent must get the
 * retirement text whatever it passes.
 */
export const gateServer = (server: McpServer, now: Clock = () => new Date()): void => {
    const registerTool = server.registerTool.bind(server) as unknown as (
        name: string,
        config: ToolConfig,
        cb: ToolCallback,
    ) => unknown;
    const registerResource = server.registerResource.bind(server) as unknown as (
        name: string,
        uri: string,
        meta: unknown,
        cb: ResourceCallback,
    ) => unknown;

    server.registerTool = ((name: string, config: ToolConfig, cb: ToolCallback) =>
        registerTool(
            name,
            isSunset(now()) ? { title: config.title, description: SUNSET_MESSAGE } : config,
            async (...args) => {
                if (isSunset(now())) return retiredToolResult(name);
                const result = await cb(...args);
                return { ...result, content: [...result.content, { type: 'text', text: SUNSET_NOTICE }] };
            },
        )) as unknown as typeof server.registerTool;

    server.registerResource = ((name: string, uri: string, meta: unknown, cb: ResourceCallback) =>
        registerResource(name, uri, meta, async (resourceUri, ...rest) =>
            isSunset(now()) ? retiredResource(resourceUri) : cb(resourceUri, ...rest),
        )) as unknown as typeof server.registerResource;
};
