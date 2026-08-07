import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveResponseFiles, attachmentNote } from './response-files.js';
import type { ZephApiClient } from './api-client.js';

const dirs: string[] = [];
const scratch = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'zeph-attach-'));
    dirs.push(d);
    return d;
};

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const file = (over: Partial<{ fileKey: string; fileName: string }> = {}) => ({
    fileKey: 'files/shot.png',
    fileName: 'shot.png',
    fileType: 'image/png',
    fileSize: 3,
    ...over,
});

const client = {} as ZephApiClient;

describe('saveResponseFiles', () => {
    it('writes each attachment under the event and returns absolute paths', async () => {
        const dir = scratch();
        const fetchBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));

        const paths = await saveResponseFiles(client, 'evt_1', [file()], { dir, fetchBytes });

        expect(paths).toEqual([join(dir, 'hook-evt_1', 'shot.png')]);
        expect(Array.from(readFileSync(paths[0]))).toEqual([1, 2, 3]);
        expect(fetchBytes).toHaveBeenCalledWith('files/shot.png');
    });

    it('does nothing at all when the answer carried no files', async () => {
        const dir = scratch();
        const fetchBytes = vi.fn();

        expect(await saveResponseFiles(client, 'evt_1', undefined, { dir, fetchBytes })).toEqual([]);
        expect(await saveResponseFiles(client, 'evt_1', [], { dir, fetchBytes })).toEqual([]);
        // Not even the directory — an answer without files leaves no trace.
        expect(existsSync(join(dir, 'hook-evt_1'))).toBe(false);
        expect(fetchBytes).not.toHaveBeenCalled();
    });

    it('keeps the files that did download when one fails', async () => {
        // A question that was answered has been answered — one dead S3 key must
        // not cost the user the whole reply.
        const dir = scratch();
        const fetchBytes = vi.fn(async (key: string) => {
            if (key === 'files/bad.png') throw new Error('404');
            return new Uint8Array([9]);
        });

        const paths = await saveResponseFiles(
            client,
            'evt_1',
            [file({ fileKey: 'files/bad.png', fileName: 'bad.png' }), file()],
            { dir, fetchBytes },
        );

        expect(paths).toEqual([join(dir, 'hook-evt_1', 'shot.png')]);
    });

    it('refuses to let a file name escape its directory', async () => {
        const dir = scratch();
        const fetchBytes = vi.fn(async () => new Uint8Array([1]));

        const paths = await saveResponseFiles(
            client,
            '../../evt',
            [file({ fileName: '../../../.ssh/authorized_keys' })],
            { dir, fetchBytes },
        );

        expect(paths).toEqual([join(dir, 'evt', 'authorized_keys')]);
    });
});

describe('attachmentNote', () => {
    it('says nothing when there is nothing to say', () => {
        expect(attachmentNote([])).toEqual({});
    });

    it('names the paths and tells the agent to open them', () => {
        const note = attachmentNote(['/a.png', '/b.png']);

        expect(note.attachments).toEqual(['/a.png', '/b.png']);
        expect(note.attachmentsNote).toContain('2 file(s)');
    });
});
