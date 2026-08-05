import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import { textResult, formatToolError } from '../error-format.js';
import { formatPushTitle, type McpServerConfig } from '../config.js';
import { encryptPushBodyForDevices, encryptFileForDevices, type DeviceRecipient } from '../crypto.js';
import { withPlaintextFallback } from '../e2e-fallback.js';
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
      // Runs a second time as plaintext if the server refuses E2E (Pro-only,
      // ADR-0008) — hence everything after the encryption decision lives here.
      const send = async (recipients: DeviceRecipient[] | null) => {
        const deviceId = targetDeviceId ?? config.deviceId;
        const pushTitle = formatPushTitle(config.projectName, title);
        // Strip any tool-call markup that leaked into the body argument.
        const cleanBody = sanitizeText(body);
        // Attach a file whenever the body would be clipped in the feed preview.
        const isLongBody = !!cleanBody && cleanBody.length > PREVIEW_LENGTH;

        if (isLongBody && cleanBody) {
          const fileName = 'response.md';
          const fileType = inferMimeType(fileName);

          // Self-contained Markdown so the file alone carries the full text.
          const fileMarkdown = `# ${title}\n\n${cleanBody}`;
          const fileBytes = new TextEncoder().encode(fileMarkdown).byteLength;

          const preview = cleanBody.slice(0, PREVIEW_LENGTH) + '...';

          // Encrypt the attachment and the push body together, before anything
          // is uploaded. Doing them one at a time around the upload let a
          // failure land in between and ship ciphertext under a push with no
          // `isEncrypted` — an attachment no client would even try to open.
          let encrypted: {
            file: Awaited<ReturnType<typeof encryptFileForDevices>>;
            push: Awaited<ReturnType<typeof encryptPushBodyForDevices>>;
          } | null = null;
          if (recipients) {
            try {
              encrypted = {
                file: await encryptFileForDevices(fileMarkdown, recipients),
                push: await encryptPushBodyForDevices({ title: pushTitle, body: preview, url }, recipients),
              };
            } catch (err) {
              console.error('[Crypto] Encryption failed, sending plaintext:', err);
            }
          }

          const uploadContent: string | Buffer = encrypted?.file.ciphertext ?? fileMarkdown;
          const uploadContentType = encrypted ? 'application/octet-stream' : fileType;

          const upload = await client.requestUpload({ fileName, fileType: uploadContentType, fileSize: typeof uploadContent === 'string' ? fileBytes : uploadContent.length });
          await client.uploadToS3(upload.data.uploadUrl, uploadContent, uploadContentType);

          const pushPayload: Record<string, unknown> = {
            title: encrypted ? undefined : pushTitle,
            body: encrypted ? encrypted.push.body : preview,
            url,
            type: 'file',
            priority,
            files: [{
              fileKey: upload.data.fileKey,
              fileName,
              fileSize: fileBytes,
              fileType,
              iv: encrypted?.file.iv,
              deviceKeyMap: encrypted?.file.deviceKeyMap,
            }],
            targetDeviceId: deviceId,
            sessionId: config.sessionId,
            ...(encrypted && {
              isEncrypted: encrypted.push.isEncrypted,
              deviceKeyMap: encrypted.push.deviceKeyMap,
              senderPublicKey: encrypted.push.senderPublicKey,
            }),
          };

          const result = await client.sendPush(pushPayload as Parameters<typeof client.sendPush>[0]);
          // Report what actually went out — an encryption failure above falls
          // back to plaintext, so the recipient list alone would over-claim.
          return textResult({ pushId: result.data.pushId, fileKey: upload.data.fileKey, autoFile: true, encrypted: !!encrypted });
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

        let pushEncrypted = false;
        if (recipients) {
          try {
            const enc = await encryptPushBodyForDevices({ title: pushTitle, body: cleanBody, url }, recipients);
            pushPayload = { ...pushPayload, title: undefined, body: enc.body, isEncrypted: enc.isEncrypted, deviceKeyMap: enc.deviceKeyMap, senderPublicKey: enc.senderPublicKey };
            pushEncrypted = true;
          } catch (err) {
            console.error('[Crypto] Push encryption failed, sending plaintext:', err);
          }
        }

        const result = await client.sendPush(pushPayload as Parameters<typeof client.sendPush>[0]);
        return textResult({ pushId: result.data.pushId, encrypted: pushEncrypted });
      };

      try {
        return await withPlaintextFallback(client, send);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
