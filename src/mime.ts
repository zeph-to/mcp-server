/**
 * Shared MIME-type inference for file/notify/ask payloads.
 *
 * Kept in one place so different tools don't produce inconsistent types
 * for the same extension (e.g. `.csv` ending up as text/plain in one
 * code path and text/csv in another).
 */

const EXT_TO_MIME: Record<string, string> = {
    txt: 'text/plain',
    log: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    csv: 'text/csv',
    html: 'text/html',
    xml: 'text/xml',
    yaml: 'text/yaml',
    yml: 'text/yaml',
    ts: 'text/typescript',
    js: 'text/javascript',
    py: 'text/x-python',
    sh: 'text/x-shellscript',
    // Keep this image set in sync with IMAGE_EXTENSIONS in the Zeph client
    // (`libs/shared/src/utils/file.ts`) — an extension the client calls an image
    // but this map doesn't will be labelled text/plain and decoded as UTF-8 on
    // open, which corrupts it. Separate repos, so nothing enforces the match.
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
    bmp: 'image/bmp',
    avif: 'image/avif',
    ico: 'image/x-icon',
    tiff: 'image/tiff',
    tif: 'image/tiff',
    // No svg entry on purpose: an SVG is a script-bearing document, and the
    // clients open decrypted attachments from a same-origin blob URL. It falls
    // through to text/plain, which the text viewer handles fine.
    pdf: 'application/pdf',
};

export const inferMimeType = (fileName: string): string => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    return EXT_TO_MIME[ext ?? ''] ?? 'text/plain';
};
