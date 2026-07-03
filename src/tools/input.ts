import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZephApiClient } from '../api-client.js';
import { textResult, hookNotConfiguredError, timeoutError, formatToolError } from '../error-format.js';
import { pollForResponse } from '../poll.js';
import { formatPushTitle, type McpServerConfig } from '../config.js';
import { sanitizeText } from '../sanitize.js';
import type { HookResponseWaiter } from '../ws-wait.js';

export const registerInputTool = (server: McpServer, client: ZephApiClient, config: McpServerConfig, waiter?: HookResponseWaiter) => {
  server.registerTool(
    'zeph_input',
    {
      description:
        'Request text input from the user via push notification. The tool blocks until the user responds or the timeout is reached. Requires ZEPH_HOOK_ID environment variable.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        title: z.string().describe('Input request title'),
        body: z.string().optional().describe('Instructions or context'),
        placeholder: z.string().optional().describe('Input placeholder hint'),
        inputType: z
          .enum(['text', 'password', 'multiline'])
          .default('text')
          .describe('Input field type'),
        timeout: z
          .number()
          .min(10)
          .max(600)
          .default(120)
          .describe('Seconds to wait for response (default: 120)'),
      },
    },
    async ({ title, body, placeholder, inputType, timeout }, ctx): Promise<CallToolResult> => {
      if (!config.hookId) return hookNotConfiguredError();

      try {
        const trigger = await client.triggerHook(config.hookId, {
          title: formatPushTitle(config.projectName, title),
          body: sanitizeText(body),
          timeout,
          hookType: 'input',
          metadata: { placeholder, inputType },
          sessionId: config.sessionId,
        });

        const event = await pollForResponse(
          client,
          config.hookId,
          trigger.data.eventId,
          timeout,
          ctx,
          waiter,
        );

        if (!event) return timeoutError(timeout, 'Try again with a longer timeout');

        return textResult({ value: event.data.response?.value ?? '', timedOut: false });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
