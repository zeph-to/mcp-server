import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import { textResult, formatToolError } from '../error-format.js';

export const registerListTool = (server: McpServer, client: ZephApiClient) => {
  server.registerTool(
    'zeph_list',
    {
      description:
        'List recent push notifications. Use this to check notification history, avoid duplicates, or reference previous messages.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        limit: z
          .number()
          .min(1)
          .max(20)
          .default(5)
          .describe('Number of pushes to return (default: 5, max: 20)'),
        type: z
          .enum(['note', 'link', 'file', 'clipboard', 'hook'])
          .optional()
          .describe('Filter by push type'),
      },
    },
    async ({ limit, type }) => {
      try {
        const result = await client.listPushes({ limit, type });
        const summary = result.data.map((p) => ({
          pushId: p.pushId,
          type: p.type,
          title: p.title,
          body: p.body?.slice(0, 100),
          createdAt: p.createdAt,
        }));
        return textResult({ pushes: summary, total: summary.length, hasMore: result.pagination.hasMore });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
