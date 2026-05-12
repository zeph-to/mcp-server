import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import { textResult, formatToolError } from '../error-format.js';
import type { McpServerConfig } from '../config.js';

const BODY_FILE_THRESHOLD = 0;
const PREVIEW_LENGTH = 200;

const inferMimeType = (fileName: string): string => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = { md: 'text/markdown', txt: 'text/plain', json: 'application/json' };
  return map[ext ?? ''] ?? 'text/plain';
};

export const registerNotifyTool = (server: McpServer, client: ZephApiClient, config: McpServerConfig) => {
  server.registerTool(
    'zeph_notify',
    {
      description:
        'Send a one-way push notification to the user\'s devices. Use this to inform the user about task completion, errors, or status updates. Long bodies (>1KB) are automatically uploaded as a file for full viewing.',
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
        const deviceId = targetDeviceId ?? config.deviceId;
        const bodyBytes = body ? new TextEncoder().encode(body).byteLength : 0;
        const isLongBody = bodyBytes > BODY_FILE_THRESHOLD;

        if (isLongBody && body) {
          const fileName = 'response.md';
          const fileType = inferMimeType(fileName);
          const fileSize = bodyBytes;

          const upload = await client.requestUpload({ fileName, fileType, fileSize });
          await client.uploadToS3(upload.data.uploadUrl, body, fileType);

          const preview = body.length > PREVIEW_LENGTH ? body.slice(0, PREVIEW_LENGTH) + '...' : body;
          const result = await client.sendPush({
            title,
            body: preview,
            url,
            type: 'file',
            priority,
            files: [{ fileKey: upload.data.fileKey, fileName, fileSize, fileType }],
            targetDeviceId: deviceId,
          });
          return textResult({ pushId: result.data.pushId, fileKey: upload.data.fileKey, autoFile: true });
        }

        const result = await client.sendPush({
          title,
          body,
          url,
          type: 'hook',
          priority,
          targetDeviceId: deviceId,
        });
        return textResult({ pushId: result.data.pushId });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
