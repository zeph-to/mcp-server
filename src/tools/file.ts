import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import { formatPushTitle, type McpServerConfig } from '../config.js';
import { textResult, errorResult, formatToolError } from '../error-format.js';
import { encryptPushBodyForDevices, encryptFileForDevices, type DeviceRecipient } from '../crypto.js';
import { withPlaintextFallback } from '../e2e-fallback.js';
import { inferMimeType } from '../mime.js';

type FilePayload = { fileName: string; body: string | Buffer; size: number };

/**
 * Collapse the two accepted input shapes into one payload.
 *
 * A `filePath` stays a Buffer end to end — images and PDFs only survive the
 * trip as raw bytes, and reading from disk keeps a several-hundred-KB
 * attachment out of the tool call itself (base64 in the arguments would
 * inflate it by a third and burn the agent's context).
 */
const resolvePayload = async (args: { filePath?: string; content?: string; fileName?: string }): Promise<FilePayload> => {
  if (args.filePath) {
    const body = await readFile(args.filePath);
    return { fileName: args.fileName ?? basename(args.filePath), body, size: body.byteLength };
  }
  return {
    fileName: args.fileName!,
    body: args.content!,
    size: new TextEncoder().encode(args.content!).byteLength,
  };
};

export const registerFileTool = (server: McpServer, client: ZephApiClient, config: McpServerConfig) => {
  server.registerTool(
    'zeph_file',
    {
      description:
        'Send a file to the user\'s device. Pass `filePath` to send a file that already exists on disk — images (png/jpg/gif/webp/heic), PDFs, logs, anything. Pass `content` instead to send text you generated. Images render inline on the device.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        filePath: z
          .string()
          .optional()
          .describe('Absolute path to a local file to send. Required for images, PDFs, and any other binary — never base64 a file into `content`.'),
        content: z.string().optional().describe('Text content of the file. Use only for text you generated; requires `fileName`.'),
        fileName: z
          .string()
          .optional()
          .describe('File name with extension (e.g., "report.txt"). Required with `content`; defaults to the basename of `filePath`.'),
        title: z.string().optional().describe('Notification title (defaults to fileName)'),
        targetDeviceId: z.string().optional().describe('Target device ID. Omit to use configured default or send to all devices.'),
      },
    },
    async ({ filePath, fileName: fileNameArg, content, title, targetDeviceId }) => {
      if (!filePath && content === undefined) {
        return errorResult({
          error: 'INVALID_INPUT',
          message: 'Either filePath or content is required',
          suggestion: 'Pass filePath for a file on disk (images, PDFs), or content + fileName for generated text',
        });
      }
      if (!filePath && !fileNameArg) {
        return errorResult({
          error: 'INVALID_INPUT',
          message: 'fileName is required when sending content',
          suggestion: 'Add fileName with an extension, e.g. "report.md"',
        });
      }

      let payload: FilePayload;
      try {
        // Resolved once, outside `send`, so the plaintext retry below doesn't
        // read the file from disk a second time.
        payload = await resolvePayload({ filePath, content, fileName: fileNameArg });
      } catch (err) {
        return errorResult({
          error: 'FILE_READ_FAILED',
          message: err instanceof Error ? err.message : String(err),
          suggestion: 'Check that filePath is an absolute path to a readable file',
        });
      }
      const { fileName, body, size: originalSize } = payload;

      // Runs a second time as plaintext if the server refuses E2E (Pro-only,
      // ADR-0008). The retry re-uploads the file unencrypted, so the whole
      // upload-then-send sequence has to sit inside this closure.
      const send = async (recipients: DeviceRecipient[] | null) => {
        let fileType = inferMimeType(fileName);

        // Step 1: Optionally encrypt file content
        let uploadContent: string | Buffer = body;
        let uploadSize = originalSize;
        let fileIv: string | undefined;
        let fileDeviceKeyMap: Record<string, string> | undefined;

        if (recipients) {
          try {
            const encrypted = await encryptFileForDevices(body, recipients);
            uploadContent = encrypted.ciphertext;
            uploadSize = encrypted.ciphertext.length;
            fileType = 'application/octet-stream';
            fileIv = encrypted.iv;
            fileDeviceKeyMap = encrypted.deviceKeyMap;
          } catch (err) {
            console.error('[Crypto] File encryption failed, sending plaintext:', err);
          }
        }

        // Step 2: Request upload URL
        const upload = await client.requestUpload({ fileName, fileType, fileSize: uploadSize });

        // Step 3: Upload content to S3
        await client.uploadToS3(upload.data.uploadUrl, uploadContent, fileType);

        // Step 4: Send file push (encrypt push body if possible)
        const pushTitle = formatPushTitle(config.projectName, title ?? fileName);
        let pushPayload: Record<string, unknown> = {
          title: pushTitle,
          type: 'file',
          files: [{ fileKey: upload.data.fileKey, fileName, fileSize: originalSize, fileType: inferMimeType(fileName), iv: fileIv, deviceKeyMap: fileDeviceKeyMap }],
          targetDeviceId: targetDeviceId ?? config.deviceId,
          sessionId: config.sessionId,
        };

        let pushEncrypted = false;
        if (recipients) {
          try {
            const enc = await encryptPushBodyForDevices({ title: pushTitle }, recipients);
            pushPayload = { ...pushPayload, title: undefined, body: enc.body, isEncrypted: enc.isEncrypted, deviceKeyMap: enc.deviceKeyMap, senderPublicKey: enc.senderPublicKey };
            pushEncrypted = true;
          } catch (err) {
            console.error('[Crypto] Push encryption failed, sending plaintext:', err);
          }
        }

        const result = await client.sendPush(pushPayload as Parameters<typeof client.sendPush>[0]);
        // Report what actually went out — an encryption failure above falls
        // back to plaintext, so the recipient list alone would over-claim.
        return textResult({
          pushId: result.data.pushId,
          fileKey: upload.data.fileKey,
          fileSize: originalSize,
          encrypted: !!fileDeviceKeyMap && pushEncrypted,
        });
      };

      try {
        return await withPlaintextFallback(client, send);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
