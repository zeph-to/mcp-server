import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZephApiClient } from '../api-client.js';
import { textResult, hookNotConfiguredError, timeoutError, formatToolError } from '../error-format.js';
import { pollForResponse } from '../poll.js';
import type { McpServerConfig } from '../config.js';

export const registerAskTool = (server: McpServer, client: ZephApiClient, config: McpServerConfig) => {
  server.registerTool(
    'zeph_ask',
    {
      description:
        'Ask the user a question with optional quick-reply buttons and a text input field. Combines prompt (buttons) and input (text) in a single notification. The user can either tap a button or type a response. Blocks until the user responds or the timeout is reached. Requires ZEPH_HOOK_ID environment variable.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        title: z.string().describe('Question or request title'),
        body: z.string().optional().describe('Context or instructions'),
        actions: z
          .array(
            z.object({
              id: z.string().describe('Unique action identifier'),
              label: z.string().describe('Display label for the button'),
              style: z.enum(['primary', 'secondary', 'danger']).default('secondary')
                .describe('Button style (default: secondary)'),
            }),
          )
          .min(1)
          .max(4)
          .optional()
          .describe('Quick-reply buttons (1-4). Omit for text-only input'),
        placeholder: z.string().optional().describe('Input field placeholder hint'),
        inputType: z
          .enum(['text', 'multiline'])
          .default('text')
          .describe('Input field type (default: text)'),
        timeout: z
          .number()
          .min(10)
          .max(600)
          .default(120)
          .describe('Seconds to wait for response (default: 120)'),
        fallback: z
          .string()
          .optional()
          .describe('Action ID to auto-select on timeout'),
      },
    },
    async ({ title, body, actions, placeholder, inputType, timeout, fallback }, ctx): Promise<CallToolResult> => {
      if (!config.hookId) return hookNotConfiguredError();

      try {
        const trigger = await client.triggerHook(config.hookId, {
          title,
          body,
          actions,
          timeout,
          fallback,
          hookType: 'combo',
          metadata: { placeholder, inputType },
        });

        const event = await pollForResponse(
          client,
          config.hookId,
          trigger.data.eventId,
          timeout,
          ctx,
        );

        if (!event) {
          if (fallback) return textResult({ actionId: fallback, timedOut: true });
          return timeoutError(timeout, 'Try again or use zeph_notify for one-way communication');
        }

        const response = event.data.response;
        if (response?.actionId) return textResult({ actionId: response.actionId, timedOut: false });
        return textResult({ value: response?.value ?? '', timedOut: false });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
