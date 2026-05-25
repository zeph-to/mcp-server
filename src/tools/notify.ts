import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import { textResult, formatToolError } from '../error-format.js';
import { formatPushTitle, type McpServerConfig } from '../config.js';
import { getKeyPair, getPublicKey, encryptPushBodyForSelf, encryptFileForSelf } from '../crypto.js';
import { inferMimeType } from '../mime.js';
import { sanitizeText } from '../sanitize.js';

// The device feed shows a short preview of the body. Anything longer gets
// truncated there, so we attach the full text as a file for full viewing.
const PREVIEW_LENGTH = 200;

export const registerNotifyTool = (server: McpServer, client: ZephApiClient, config: McpServerConfig) => {
  server.registerTool(
    'zeph_notify',
    {
      description:
        'Send a one-way push notification to the user\'s devices. Use this to inform the user about task completion, errors, or status updates. Long bodies are automatically uploaded as a file for full viewing.',
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
        const pushTitle = formatPushTitle(config.projectName, title);
        // Strip any tool-call markup that leaked into the body argument.
        const cleanBody = sanitizeText(body);
        // Attach a file whenever the body would be clipped in the feed preview.
        const isLongBody = !!cleanBody && cleanBody.length > PREVIEW_LENGTH;
        const canEncrypt = !!getKeyPair() && !!getPublicKey();

        if (isLongBody && cleanBody) {
          const fileName = 'response.md';
          const fileType = inferMimeType(fileName);

          // Self-contained Markdown so the file alone carries the full text.
          const fileMarkdown = `# ${title}\n\n${cleanBody}`;
          const fileBytes = new TextEncoder().encode(fileMarkdown).byteLength;

          // Encrypt file content if keys available
          let uploadContent: string | Buffer = fileMarkdown;
          let uploadContentType = fileType;
          let fileIv: string | undefined;
          let fileEncryptedKey: string | undefined;

          if (canEncrypt) {
            try {
              const encrypted = await encryptFileForSelf(fileMarkdown);
              uploadContent = encrypted.ciphertext;
              uploadContentType = 'application/octet-stream';
              fileIv = encrypted.iv;
              fileEncryptedKey = encrypted.encryptedKey;
            } catch (err) {
              console.error('[Crypto] File encryption failed, sending plaintext:', err);
            }
          }

          const upload = await client.requestUpload({ fileName, fileType: uploadContentType, fileSize: typeof uploadContent === 'string' ? fileBytes : uploadContent.length });
          await client.uploadToS3(upload.data.uploadUrl, uploadContent, uploadContentType);

          const preview = cleanBody.slice(0, PREVIEW_LENGTH) + '...';

          // Encrypt push body (title/preview/url) if keys available
          let pushPayload: Record<string, unknown> = {
            title: pushTitle,
            body: preview,
            url,
            type: 'file',
            priority,
            files: [{ fileKey: upload.data.fileKey, fileName, fileSize: fileBytes, fileType, iv: fileIv, encryptedKey: fileEncryptedKey }],
            targetDeviceId: deviceId,
            sessionId: config.sessionId,
          };

          if (canEncrypt) {
            try {
              const enc = await encryptPushBodyForSelf({ title: pushTitle, body: preview, url });
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
          title: pushTitle,
          body: cleanBody,
          url,
          type: 'hook',
          priority,
          targetDeviceId: deviceId,
          sessionId: config.sessionId,
        };

        if (canEncrypt) {
          try {
            const enc = await encryptPushBodyForSelf({ title: pushTitle, body: cleanBody, url });
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
