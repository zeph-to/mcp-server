import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import { textResult, formatToolError } from '../error-format.js';
import type { McpServerConfig } from '../config.js';
import { getKeyPair, encryptPushBody, encryptFileForSelf } from '../crypto.js';

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
        const canEncrypt = !!getKeyPair();

        if (isLongBody && body) {
          const fileName = 'response.md';
          const fileType = inferMimeType(fileName);
          const fileSize = bodyBytes;

          // Encrypt file if possible
          let uploadContent: string | Buffer = body;
          let uploadContentType = fileType;
          let fileIv: string | undefined;
          let fileEncryptedKey: string | undefined;

          if (canEncrypt) {
            try {
              const encrypted = await encryptFileForSelf(body);
              if (encrypted) {
                uploadContent = encrypted.ciphertext;
                uploadContentType = 'application/octet-stream';
                fileIv = encrypted.iv;
                fileEncryptedKey = encrypted.encryptedKey;
              }
            } catch (err) {
              console.error('[Crypto] File encryption failed:', err);
            }
          }

          const upload = await client.requestUpload({ fileName, fileType: uploadContentType, fileSize: typeof uploadContent === 'string' ? fileSize : uploadContent.length });
          await client.uploadToS3(upload.data.uploadUrl, uploadContent, uploadContentType);

          const preview = body.length > PREVIEW_LENGTH ? body.slice(0, PREVIEW_LENGTH) + '...' : body;

          // Encrypt push body
          const enc = canEncrypt ? await encryptPushBody({ title, body: preview, url }).catch(() => null) : null;
          const result = await client.sendPush({
            title: enc ? undefined : title,
            body: enc?.body ?? preview,
            url,
            type: 'file',
            priority,
            files: [{ fileKey: upload.data.fileKey, fileName, fileSize, fileType, iv: fileIv, encryptedKey: fileEncryptedKey }],
            targetDeviceId: deviceId,
            ...(enc ? { isEncrypted: enc.isEncrypted, encryptedKey: enc.encryptedKey, senderPublicKey: enc.senderPublicKey } : {}),
          });
          return textResult({ pushId: result.data.pushId, fileKey: upload.data.fileKey, autoFile: true, encrypted: !!enc });
        }

        // Short body — encrypt push
        const enc = canEncrypt ? await encryptPushBody({ title, body, url }).catch(() => null) : null;
        const result = await client.sendPush({
          title: enc ? undefined : title,
          body: enc?.body ?? body,
          url,
          type: 'hook',
          priority,
          targetDeviceId: deviceId,
          ...(enc ? { isEncrypted: enc.isEncrypted, encryptedKey: enc.encryptedKey, senderPublicKey: enc.senderPublicKey } : {}),
        });
        return textResult({ pushId: result.data.pushId, encrypted: !!enc });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
