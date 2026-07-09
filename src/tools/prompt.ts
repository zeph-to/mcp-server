import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZephApiClient } from '../api-client.js';
import { textResult, hookNotConfiguredError, timeoutError, formatToolError } from '../error-format.js';
import { pollForResponse } from '../poll.js';
import { formatPushTitle, type McpServerConfig } from '../config.js';
import { sanitizeText } from '../sanitize.js';
import type { HookResponseWaiter } from '../ws-wait.js';

export const registerPromptTool = (server: McpServer, client: ZephApiClient, config: McpServerConfig, waiter?: HookResponseWaiter) => {
  server.registerTool(
    'zeph_prompt',
    {
      description:
        'Ask the user to choose from predefined options via push notification. The tool blocks until the user responds or the timeout is reached. Requires ZEPH_HOOK_ID environment variable.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        title: z.string().describe('Question or request title'),
        body: z.string().optional().describe('Detailed description'),
        actions: z
          .array(
            z.object({
              id: z.string().describe('Unique action identifier'),
              label: z.string().describe('Display label for the button'),
              style: z.enum(['primary', 'secondary', 'danger']).default('secondary')
                .describe('Button style (default: secondary)'),
            }),
          )
          .min(2)
          .max(4)
          .describe('Choice options (2-4 items)'),
        timeout: z
          .number()
          .min(10)
          .max(300)
          .default(120)
          .describe('Seconds to wait for response (default: 120)'),
        fallback: z
          .string()
          .optional()
          .describe('Action ID to auto-select on timeout'),
      },
    },
    async ({ title, body, actions, timeout, fallback }, ctx): Promise<CallToolResult> => {
      if (!config.hookId) return hookNotConfiguredError();

      try {
        const trigger = await client.triggerHook(config.hookId, {
          title: formatPushTitle(config.projectName, title),
          body: sanitizeText(body),
          actions,
          timeout,
          fallback,
          hookType: 'interactive',
          sessionId: config.sessionId,
          agentDeviceId: config.agentDeviceId,
          agentSessionName: config.agentSessionName,
        });

        const event = await pollForResponse(
          client,
          config.hookId,
          trigger.data.eventId,
          timeout,
          ctx,
          waiter,
        );

        if (!event) {
          if (fallback) return textResult({ actionId: fallback, timedOut: true });
          return timeoutError(timeout, 'Try again or use zeph_notify for one-way communication');
        }

        return textResult({ actionId: event.data.response?.actionId, timedOut: false });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
