import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import { textResult, formatToolError } from '../error-format.js';
import type { McpServerConfig } from '../config.js';

export const registerClipboardTool = (server: McpServer, client: ZephApiClient, config: McpServerConfig) => {
  server.registerTool(
    'zeph_clipboard',
    {
      description:
        'Copy text to the user\'s device clipboard. The text will appear in their clipboard history and can be pasted immediately.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        text: z.string().describe('Text to copy to clipboard'),
        targetDeviceId: z.string().optional().describe('Target device ID. Omit to use configured default or send to all devices.'),
      },
    },
    async ({ text, targetDeviceId }) => {
      try {
        const result = await client.sendPush({
          title: 'Clipboard',
          body: text,
          type: 'clipboard',
          targetDeviceId: targetDeviceId ?? config.deviceId,
          sessionId: config.sessionId,
        });
        return textResult({ pushId: result.data.pushId });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
