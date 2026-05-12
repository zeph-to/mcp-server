import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import { textResult, formatToolError } from '../error-format.js';

export const registerFileTool = (server: McpServer, client: ZephApiClient, config: McpServerConfig) => {
  server.registerTool(
    'zeph_file',
    {
      description:
        'Send a text file to the user\'s device. The content is uploaded and delivered as a file push. Use for logs, reports, code snippets, or any text content.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        fileName: z.string().describe('File name with extension (e.g., "report.txt", "output.json")'),
        content: z.string().describe('Text content of the file'),
        title: z.string().optional().describe('Notification title (defaults to fileName)'),
        targetDeviceId: z.string().optional().describe('Target device ID. Omit to use configured default or send to all devices.'),
      },
    },
    async ({ fileName, content, title, targetDeviceId }) => {
      try {
        const fileType = inferMimeType(fileName);
        const fileSize = new TextEncoder().encode(content).byteLength;

        // Step 1: Request upload URL
        const upload = await client.requestUpload({ fileName, fileType, fileSize });

        // Step 2: Upload content to S3
        await client.uploadToS3(upload.data.uploadUrl, content, fileType);

        // Step 3: Send file push
        const result = await client.sendPush({
          title: title ?? fileName,
          type: 'file',
          fileKey: upload.data.fileKey,
          fileName,
          fileSize,
          fileType,
          targetDeviceId: targetDeviceId ?? config.deviceId,
        });

        return textResult({ pushId: result.data.pushId, fileKey: upload.data.fileKey, fileSize });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};

const inferMimeType = (fileName: string): string => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    txt: 'text/plain',
    json: 'application/json',
    csv: 'text/csv',
    md: 'text/markdown',
    html: 'text/html',
    xml: 'text/xml',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    log: 'text/plain',
    ts: 'text/typescript',
    js: 'text/javascript',
    py: 'text/x-python',
    sh: 'text/x-shellscript',
  };
  return map[ext ?? ''] ?? 'text/plain';
};
