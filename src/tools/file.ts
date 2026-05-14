import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import { textResult, formatToolError } from '../error-format.js';
import { getKeyPair, encryptPushBody, encryptFileForSelf } from '../crypto.js';

const inferMimeType = (fileName: string): string => {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    txt: 'text/plain', json: 'application/json', csv: 'text/csv',
    md: 'text/markdown', html: 'text/html', xml: 'text/xml',
    yaml: 'text/yaml', yml: 'text/yaml', log: 'text/plain',
    ts: 'text/typescript', js: 'text/javascript', py: 'text/x-python', sh: 'text/x-shellscript',
  };
  return map[ext ?? ''] ?? 'text/plain';
};

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
        const canEncrypt = !!getKeyPair();
        const originalFileType = inferMimeType(fileName);
        const originalSize = new TextEncoder().encode(content).byteLength;

        let uploadContent: string | Buffer = content;
        let uploadFileType = originalFileType;
        let uploadSize = originalSize;
        let fileIv: string | undefined;
        let fileEncryptedKey: string | undefined;

        if (canEncrypt) {
          try {
            const encrypted = await encryptFileForSelf(content);
            if (encrypted) {
              uploadContent = encrypted.ciphertext;
              uploadFileType = 'application/octet-stream';
              uploadSize = encrypted.ciphertext.length;
              fileIv = encrypted.iv;
              fileEncryptedKey = encrypted.encryptedKey;
            }
          } catch (err) {
            console.error('[Crypto] File encryption failed:', err);
          }
        }

        const upload = await client.requestUpload({ fileName, fileType: uploadFileType, fileSize: uploadSize });
        await client.uploadToS3(upload.data.uploadUrl, uploadContent, uploadFileType);

        const pushTitle = title ?? fileName;
        const enc = canEncrypt ? await encryptPushBody({ title: pushTitle }).catch(() => null) : null;

        const result = await client.sendPush({
          title: enc ? undefined : pushTitle,
          body: enc?.body,
          type: 'file',
          files: [{ fileKey: upload.data.fileKey, fileName, fileSize: originalSize, fileType: originalFileType, iv: fileIv, encryptedKey: fileEncryptedKey }],
          targetDeviceId: targetDeviceId ?? config.deviceId,
          ...(enc ? { isEncrypted: enc.isEncrypted, encryptedKey: enc.encryptedKey, senderPublicKey: enc.senderPublicKey } : {}),
        });

        return textResult({ pushId: result.data.pushId, fileKey: upload.data.fileKey, fileSize: originalSize, encrypted: !!enc });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
