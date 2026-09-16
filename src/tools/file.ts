import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import { formatPushTitle, type McpServerConfig } from '../config.js';
import { textResult, errorResult, formatToolError } from '../error-format.js';
import { deriveLanSharedSecret, encryptPushBodyForDevices, encryptFileForDevices, getPublicKey, type DeviceRecipient } from '../crypto.js';
import { withPlaintextFallback } from '../e2e-fallback.js';
import { pickLanTarget, tryLanDelivery, type LanSealedFile } from '../lan-sender.js';
import { inferMimeType } from '../mime.js';
import type { DeviceRecord } from '../types.js';

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

/**
 * Local transfer (ADR-0013): seal the file for its one target device and hand
 * it straight over when that device can take it on this network. Null means
 * relay, and says nothing when the send was never eligible — a broadcast, a
 * device with no endpoint — so a plain cloud send stays quiet.
 *
 * Sealing happens here rather than reusing the push's encryption, because the
 * two are no longer the same question: a LAN transfer is sealed on any plan,
 * while an encrypted push needs Pro (ADR-0008). Only the target is wrapped
 * for — it is the only device that receives the bytes.
 */
const deliverLocally = async (
  devices: DeviceRecord[],
  targetDeviceId: string | undefined,
  senderDeviceId: string | undefined,
  file: { fileName: string; fileType: string; fileSize: number; body: string | Buffer },
  signal: AbortSignal | undefined,
): Promise<{ transferId: string; deviceId: string; name: string; sealed: LanSealedFile } | null> => {
  const target = pickLanTarget(devices, targetDeviceId);
  if (!target || !senderDeviceId) return null;
  // The receiver checks this host against the key registered on its device
  // record, which is the listener's to write. Without it the ping earns a 401.
  const self = devices.find((d) => d.deviceId === senderDeviceId);
  if (!self?.publicKey || self.publicKey !== getPublicKey()) return null;
  let sealed: LanSealedFile;
  try {
    const { iv, deviceKeyMap, ciphertext } = await encryptFileForDevices(file.body, [
      { deviceId: target.deviceId, publicKey: target.publicKey },
    ]);
    sealed = { fileName: file.fileName, fileType: file.fileType, fileSize: file.fileSize, iv, deviceKeyMap, ciphertext };
  } catch (err) {
    console.error('[LAN] could not seal the file, sending via cloud:', err);
    return null;
  }
  const result = await tryLanDelivery({ target, senderDeviceId, deriveSharedSecret: deriveLanSharedSecret, file: sealed, signal });
  if (!result.delivered) {
    console.error(`[LAN] ${target.deviceId}: ${result.reason} — sending via cloud`);
    return null;
  }
  const nickname = devices.find((d) => d.deviceId === target.deviceId)?.nickname;
  return { transferId: result.transferId, deviceId: target.deviceId, name: nickname || target.deviceId, sealed };
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
    async ({ filePath, fileName: fileNameArg, content, title, targetDeviceId }, extra) => {
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

      // A file handed over the LAN is already on the target machine, so the
      // retry below must not hand it over again — that would land a second
      // copy as `name (2).ext`. Remembered out here because the retry calls
      // `send` afresh; it re-sends the push record, never the bytes.
      let localDelivery: Awaited<ReturnType<typeof deliverLocally>> = null;

      // Runs a second time as plaintext if the server refuses E2E (Pro-only,
      // ADR-0008). The retry re-uploads the file unencrypted, so the whole
      // upload-then-send sequence has to sit inside this closure.
      const send = async (recipients: DeviceRecipient[] | null, devices: DeviceRecord[]) => {
        const pushTitle = formatPushTitle(config.projectName, title ?? fileName);

        const target = targetDeviceId ?? config.deviceId;
        const fileType = inferMimeType(fileName);

        /** The push body's own encryption, which needs Pro (ADR-0008) and is a
         *  separate question from whether the attachment is sealed. */
        const sealPush = async (): Promise<Awaited<ReturnType<typeof encryptPushBodyForDevices>> | null> => {
          if (!recipients) return null;
          try {
            return await encryptPushBodyForDevices({ title: pushTitle }, recipients);
          } catch (err) {
            console.error('[Crypto] Encryption failed, sending plaintext:', err);
            return null;
          }
        };
        const envelopeWith = (push: Awaited<ReturnType<typeof encryptPushBodyForDevices>> | null) => ({
          title: push ? undefined : pushTitle,
          type: 'file',
          targetDeviceId: target,
          sessionId: config.sessionId,
          ...(push && {
            body: push.body,
            isEncrypted: push.isEncrypted,
            deviceKeyMap: push.deviceKeyMap,
            senderPublicKey: push.senderPublicKey,
          }),
        });

        // Step 1: Same network as the one target device? Hand it over directly
        // — always sealed, on any plan, and anything short of a verified
        // receipt falls through to the relay below. Tried before the cloud
        // encryption so a delivered file is never encrypted twice.
        localDelivery ??= await deliverLocally(
          devices, target, config.agentDeviceId,
          { fileName, fileType, fileSize: originalSize, body },
          extra?.signal,
        );
        const local = localDelivery;
        if (local) {
          const result = await client.sendPush({
            ...envelopeWith(await sealPush()),
            files: [{
              fileName, fileSize: originalSize, fileType,
              iv: local.sealed.iv, deviceKeyMap: local.sealed.deviceKeyMap,
              lanDeliveredTo: local.deviceId, transferId: local.transferId,
            }],
          });
          return textResult({
            pushId: result.data.pushId,
            fileSize: originalSize,
            encrypted: true,
            delivery: `Sent locally to ${local.name}`,
          });
        }

        // An agent that abandoned the call abandoned the send, not just the LAN try.
        if (extra?.signal?.aborted) {
          return errorResult({ error: 'CANCELLED', message: 'The send was cancelled before the file went out' });
        }

        // Step 2: Encrypt the attachment and the push body together, before
        // anything is uploaded. Doing them one at a time around the upload let
        // a failure land in between and ship ciphertext under a push with no
        // `isEncrypted` — an attachment no client would even try to open.
        let encrypted: {
          file: Awaited<ReturnType<typeof encryptFileForDevices>>;
          push: Awaited<ReturnType<typeof encryptPushBodyForDevices>>;
        } | null = null;
        if (recipients) {
          try {
            encrypted = {
              file: await encryptFileForDevices(body, recipients),
              push: await encryptPushBodyForDevices({ title: pushTitle }, recipients),
            };
          } catch (err) {
            console.error('[Crypto] Encryption failed, sending plaintext:', err);
          }
        }
        const pushEnvelope = envelopeWith(encrypted?.push ?? null);

        const uploadContent: string | Buffer = encrypted?.file.ciphertext ?? body;
        const uploadType = encrypted ? 'application/octet-stream' : fileType;
        const uploadSize = encrypted ? encrypted.file.ciphertext.length : originalSize;

        // Step 2: Request upload URL
        const upload = await client.requestUpload({ fileName, fileType: uploadType, fileSize: uploadSize });

        // Step 3: Upload content to S3
        await client.uploadToS3(upload.data.uploadUrl, uploadContent, uploadType);

        // Step 4: Send the push. `fileType` on the descriptor stays the real
        // type — it drives how the client renders the decrypted bytes.
        const result = await client.sendPush({
          ...pushEnvelope,
          files: [{
            fileKey: upload.data.fileKey,
            fileName,
            fileSize: originalSize,
            fileType,
            iv: encrypted?.file.iv,
            deviceKeyMap: encrypted?.file.deviceKeyMap,
          }],
        });
        // Report what actually went out — an encryption failure above falls
        // back to plaintext, so the recipient list alone would over-claim.
        return textResult({
          pushId: result.data.pushId,
          fileKey: upload.data.fileKey,
          fileSize: originalSize,
          encrypted: !!encrypted,
          delivery: 'Sent via cloud',
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
