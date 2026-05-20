import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import type { McpServerConfig } from '../config.js';
import { textResult, formatToolError } from '../error-format.js';
import { getKeyPair, getPublicKey, encryptPushBodyForSelf, encryptFileForSelf } from '../crypto.js';
import { inferMimeType } from '../mime.js';

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
        const canEncrypt = !!getKeyPair() && !!getPublicKey();
        let fileType = inferMimeType(fileName);
        const originalSize = new TextEncoder().encode(content).byteLength;

        // Step 1: Optionally encrypt file content
        let uploadContent: string | Buffer = content;
        let uploadSize = originalSize;
        let fileIv: string | undefined;
        let fileEncryptedKey: string | undefined;

        if (canEncrypt) {
          try {
            const encrypted = await encryptFileForSelf(content);
            uploadContent = encrypted.ciphertext;
            uploadSize = encrypted.ciphertext.length;
            fileType = 'application/octet-stream';
            fileIv = encrypted.iv;
            fileEncryptedKey = encrypted.encryptedKey;
          } catch (err) {
            console.error('[Crypto] File encryption failed, sending plaintext:', err);
          }
        }

        // Step 2: Request upload URL
        const upload = await client.requestUpload({ fileName, fileType, fileSize: uploadSize });

        // Step 3: Upload content to S3
        await client.uploadToS3(upload.data.uploadUrl, uploadContent, fileType);

        // Step 4: Send file push (encrypt push body if possible)
        const pushTitle = title ?? fileName;
        let pushPayload: Record<string, unknown> = {
          title: pushTitle,
          type: 'file',
          files: [{ fileKey: upload.data.fileKey, fileName, fileSize: originalSize, fileType: inferMimeType(fileName), iv: fileIv, encryptedKey: fileEncryptedKey }],
          targetDeviceId: targetDeviceId ?? config.deviceId,
          sessionId: config.sessionId,
        };

        if (canEncrypt) {
          try {
            const enc = await encryptPushBodyForSelf({ title: pushTitle });
            pushPayload = { ...pushPayload, title: undefined, body: enc.body, isEncrypted: enc.isEncrypted, encryptedKey: enc.encryptedKey, senderPublicKey: enc.senderPublicKey };
          } catch (err) {
            console.error('[Crypto] Push encryption failed, sending plaintext:', err);
          }
        }

        const result = await client.sendPush(pushPayload as Parameters<typeof client.sendPush>[0]);
        return textResult({ pushId: result.data.pushId, fileKey: upload.data.fileKey, fileSize: originalSize, encrypted: canEncrypt });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
