import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import { textResult, formatToolError } from '../error-format.js';
import type { McpServerConfig } from '../config.js';

export const registerNotifyTool = (server: McpServer, client: ZephApiClient, config: McpServerConfig) => {
  server.registerTool(
    'zeph_notify',
    {
      description:
        'Send a one-way push notification to the user\'s devices. Use this to inform the user about task completion, errors, or status updates.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        title: z.string().describe('Notification title'),
        body: z.string().optional().describe('Notification body text'),
        url: z.string().url().optional().describe('Optional URL to open on the device.'),
        priority: z
          .enum(['low', 'normal', 'high', 'urgent'])
          .default('normal')
          .describe('Notification priority. Use "urgent" for critical alerts, "low" for background info.'),
        targetDeviceId: z.string().optional().describe('Target device ID. Omit to use configured default or send to all devices.'),
      },
    },
    async ({ title, body, url, priority, targetDeviceId }) => {
      try {
        const result = await client.sendPush({
          title,
          body,
          url,
          type: 'hook',
          priority,
          targetDeviceId: targetDeviceId ?? config.deviceId,
        });
        return textResult({ pushId: result.data.pushId });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
