import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZephApiClient } from '../api-client.js';
import type { AttachedFile } from '../types.js';
import { textResult, hookNotConfiguredError, timeoutError, formatToolError } from '../error-format.js';
import { pollForResponse } from '../poll.js';
import { formatPushTitle, type McpServerConfig } from '../config.js';
import { getKeyPair, getPublicKey, encryptFileForSelf } from '../crypto.js';
import { inferMimeType } from '../mime.js';
import { sanitizeText, recoverActions } from '../sanitize.js';

// The device feed shows a short preview of the body. Anything longer than
// this gets truncated there, so we attach the full text as a file — the
// user can always open the complete content instead of squinting at a
// clipped preview.
const PREVIEW_LENGTH = 200;

/** Self-contained Markdown for the attached response.md: heading + body + options. */
const buildAskMarkdown = (
  title: string,
  body: string,
  actions?: { label: string }[],
): string => {
  const parts = [`# ${title}`, '', body];
  if (actions && actions.length > 0) {
    parts.push('', '---', '', `**Options:** ${actions.map((a) => a.label).join(' · ')}`);
  }
  return parts.join('\n');
};

export const registerAskTool = (server: McpServer, client: ZephApiClient, config: McpServerConfig) => {
  server.registerTool(
    'zeph_ask',
    {
      description:
        'Ask the user a question with optional quick-reply buttons and a text input field. Combines prompt (buttons) and input (text) in a single notification. The user can either tap a button or type a response. Blocks until the user responds or the timeout is reached. Requires ZEPH_HOOK_ID environment variable.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        title: z.string().describe('Question or request title'),
        body: z.string().optional().describe('Context or instructions'),
        actions: z
          .array(
            z.object({
              id: z.string().describe('Unique action identifier'),
              label: z.string().describe('Display label for the button'),
              style: z.enum(['primary', 'secondary', 'danger']).default('secondary')
                .describe('Button style (default: secondary)'),
            }),
          )
          .min(1)
          .max(4)
          .optional()
          .describe('Quick-reply buttons (1-4). Omit for text-only input'),
        placeholder: z.string().optional().describe('Input field placeholder hint'),
        inputType: z
          .enum(['text', 'multiline'])
          .default('text')
          .describe('Input field type (default: text)'),
        timeout: z
          .number()
          .min(10)
          .max(600)
          .default(120)
          .describe('Seconds to wait for response (default: 120)'),
        fallback: z
          .string()
          .optional()
          .describe('Action ID to auto-select on timeout'),
      },
    },
    async ({ title, body, actions, placeholder, inputType, timeout, fallback }, ctx): Promise<CallToolResult> => {
      if (!config.hookId) return hookNotConfiguredError();

      try {
        const pushTitle = formatPushTitle(config.projectName, title);

        // Defend against malformed tool calls where the actions array leaked
        // into the body (a mis-closed `body` parameter). Recover the actions
        // from the raw body first, then strip the leaked markup. Without this
        // the push arrives with no buttons and raw markup in the text.
        const effectiveActions = actions && actions.length > 0 ? actions : recoverActions(body);
        const cleanBody = sanitizeText(body);

        // Attach a file whenever the body would be clipped in the feed preview.
        const exceedsPreview = !!cleanBody && cleanBody.length > PREVIEW_LENGTH;
        let triggerBody = cleanBody;
        let files: AttachedFile[] | undefined;

        if (exceedsPreview && cleanBody) {
          const fileName = 'response.md';
          const fileType = inferMimeType(fileName);
          const canEncrypt = !!getKeyPair() && !!getPublicKey();

          // Self-contained Markdown so the file alone tells the whole story.
          const fileMarkdown = buildAskMarkdown(title, cleanBody, effectiveActions);
          const fileBytes = new TextEncoder().encode(fileMarkdown).byteLength;

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

          triggerBody = cleanBody.slice(0, PREVIEW_LENGTH) + '...';
          files = [{ fileKey: upload.data.fileKey, fileName, fileSize: fileBytes, fileType, iv: fileIv, encryptedKey: fileEncryptedKey }];
        }

        const trigger = await client.triggerHook(config.hookId, {
          title: pushTitle,
          body: triggerBody,
          actions: effectiveActions,
          timeout,
          fallback,
          hookType: 'combo',
          metadata: { placeholder, inputType, files },
          files,
          sessionId: config.sessionId,
        });

        const event = await pollForResponse(
          client,
          config.hookId,
          trigger.data.eventId,
          timeout,
          ctx,
        );

        if (!event) {
          if (fallback) return textResult({ actionId: fallback, timedOut: true });
          return timeoutError(timeout, 'Try again or use zeph_notify for one-way communication');
        }

        const response = event.data.response;
        if (response?.actionId) return textResult({ actionId: response.actionId, timedOut: false });
        return textResult({ value: response?.value ?? '', timedOut: false });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
};
