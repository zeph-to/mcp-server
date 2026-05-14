import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import { textResult, formatToolError } from '../error-format.js';
import type { McpServerConfig } from '../config.js';
import { getKeyPair, getPublicKey, encryptPushBodyForSelf, encryptFileForSelf } from '../crypto.js';

const BODY_FILE_THRESHOLD = 512;
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
        'Send a one-way push notification to the user\'s devices. Use this to inform the user about task completion, errors, or status updates. Long bodies (>512B) are automatically uploaded as a file for full viewing.',
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
        const canEncrypt = !!getKeyPair() && !!getPublicKey();

        if (isLongBody && body) {
          const fileName = 'response.md';
          const fileType = inferMimeType(fileName);
          const fileSize = bodyBytes;

          // Encrypt file content if keys available
          let uploadContent: string | Buffer = body;
          let uploadContentType = fileType;
          let fileIv: string | undefined;
          let fileEncryptedKey: string | undefined;

          if (canEncrypt) {
            try {
              const encrypted = await encryptFileForSelf(body);
              uploadContent = encrypted.ciphertext;
              uploadContentType = 'application/octet-stream';
              fileIv = encrypted.iv;
              fileEncryptedKey = encrypted.encryptedKey;
            } catch (err) {
              console.error('[Crypto] File encryption failed, sending plaintext:', err);
            }
          }

          const upload = await client.requestUpload({ fileName, fileType: uploadContentType, fileSize: typeof uploadContent === 'string' ? fileSize : uploadContent.length });
          await client.uploadToS3(upload.data.uploadUrl, uploadContent, uploadContentType);

          const preview = body.length > PREVIEW_LENGTH ? body.slice(0, PREVIEW_LENGTH) + '...' : body;

          // Encrypt push body (title/preview/url) if keys available
          let pushPayload: Record<string, unknown> = {
            title,
            body: preview,
            url,
            type: 'file',
            priority,
            files: [{ fileKey: upload.data.fileKey, fileName, fileSize, fileType, iv: fileIv, encryptedKey: fileEncryptedKey }],
            targetDeviceId: deviceId,
          };

          if (canEncrypt) {
            try {
              const enc = await encryptPushBodyForSelf({ title, body: preview, url });
              pushPayload = { ...pushPayload, title: undefined, body: enc.body, isEncrypted: enc.isEncrypted, encryptedKey: enc.encryptedKey, senderPublicKey: enc.senderPublicKey };
            } catch (err) {
              console.error('[Crypto] Push encryption failed, sending plaintext:', err);
            }
          }

          const result = await client.sendPush(pushPayload as Parameters<typeof client.sendPush>[0]);
          return textResult({ pushId: result.data.pushId, fileKey: upload.data.fileKey, autoFile: true, encrypted: canEncrypt });
        }

        // Short body — encrypt push only
        let pushPayload: Record<string, unknown> = {
          title,
          body,
          url,
          type: 'hook',
          priority,
          targetDeviceId: deviceId,
        };

        if (canEncrypt) {
          try {
            const enc = await encryptPushBodyForSelf({ title, body, url });
            pushPayload = { ...pushPayload, title: undefined, body: enc.body, isEncrypted: enc.isEncrypted, encryptedKey: enc.encryptedKey, senderPublicKey: enc.senderPublicKey };
          } catch (err) {
            console.error('[Crypto] Push encryption failed, sending plaintext:', err);
          }
        }

        const result = await client.sendPush(pushPayload as Parameters<typeof client.sendPush>[0]);
        return textResult({ pushId: result.data.pushId, encrypted: canEncrypt });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
