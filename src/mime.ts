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
};

export const inferMimeType = (fileName: string): string => {
    const ext = fileName.split('.').pop()?.toLowerCase();
    return EXT_TO_MIME[ext ?? ''] ?? 'text/plain';
};
