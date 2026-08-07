/**
 * Saving the files a user attached to a hook answer.
 *
 * `zeph_ask` and `zeph_input` hand the agent a JSON result, and an agent
 * cannot look at an S3 key — so an answered screenshot only becomes useful
 * once it is a path on this machine. This module downloads each attachment
 * to `~/.zeph/attachments/hook-<eventId>/` and returns the absolute paths,
 * which the tool then names in its result for the agent to read.
 *
 * The files are plaintext by contract: the hook route carries no sender key,
 * so the server rejects an encrypted attachment on a response rather than
 * let one arrive here as bytes nothing can open.
 *
 * Failure is per file, never fatal. A question that was answered has been
 * answered; losing one image must not turn that into a tool error and make
 * the user answer again.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { ZephApiClient } from './api-client.js';
import type { AttachedFile } from './types.js';

/** Shared with the `zeph listener` daemon, which writes push attachments here. */
const ATTACHMENTS_DIR = join(homedir(), '.zeph', 'attachments');

/**
 * Make a filesystem-safe single path segment: take the basename (drops any
 * `../` prefix), strip control characters and embedded separators, remove
 * leading dots, and cap the length. Empty or dot-only names use the fallback.
 */
const safeSegment = (raw: string, fallback: string): string => {
  const cleaned = basename(raw)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || fallback).slice(0, 200);
};

/**
 * The part of a tool result that tells the agent about saved attachments.
 * Spread into the result object; empty when nothing was attached, so a plain
 * answer keeps the shape it has always had.
 *
 * The instruction is explicit because a bare list of paths in a JSON result
 * reads as metadata — the agent has to be told these are the user's answer
 * and that opening them is part of reading it.
 */
export const attachmentNote = (paths: string[]): Record<string, unknown> =>
  paths.length
    ? {
        attachments: paths,
        attachmentsNote: `The user attached ${paths.length} file(s) to this answer. Read each path above to see them.`,
      }
    : {};

export interface SaveResponseFilesDeps {
  /** Test seam for the two-step fetch (metadata → presigned URL → bytes). */
  fetchBytes?: (fileKey: string) => Promise<Uint8Array>;
  dir?: string;
}

export const saveResponseFiles = async (
  client: ZephApiClient,
  eventId: string,
  files: AttachedFile[] | undefined,
  deps: SaveResponseFilesDeps = {},
): Promise<string[]> => {
  if (!files?.length) return [];
  const fetchBytes = deps.fetchBytes ?? ((key: string) => client.downloadFile(key));
  const dir = join(deps.dir ?? ATTACHMENTS_DIR, safeSegment(`hook-${eventId}`, 'hook'));
  const paths: string[] = [];
  for (const [i, file] of files.entries()) {
    try {
      const bytes = await fetchBytes(file.fileKey);
      mkdirSync(dir, { recursive: true });
      const abs = join(dir, safeSegment(file.fileName || `file-${i}`, `file-${i}`));
      writeFileSync(abs, bytes);
      paths.push(abs);
    } catch (err) {
      console.error(`[zeph] attachment "${file.fileName}" failed to save: ${(err as Error).message}`);
    }
  }
  return paths;
};
