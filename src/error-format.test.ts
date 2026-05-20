import { describe, expect, it } from 'vitest';
import { ApiError } from './api-client.js';
import {
    textResult,
    errorResult,
    hookNotConfiguredError,
    timeoutError,
    formatToolError,
} from './error-format.js';

// All MCP tools route errors through formatToolError to produce structured
// CallToolResult payloads with isError set. Each branch maps a server-side
// error code (QUOTA_EXCEEDED, UNAUTHORIZED, etc.) to an actionable
// `suggestion` field the AI can read and surface to the user.

const parseFirstText = (r: { content: Array<{ type: string; text: string }> }) =>
    JSON.parse(r.content[0].text);

describe('textResult', () => {
    it('wraps a JSON-serialized payload as MCP text content', () => {
        const r = textResult({ pushId: 'push_01' });
        expect(r.content).toHaveLength(1);
        expect(r.content[0].type).toBe('text');
        expect(JSON.parse(r.content[0].text)).toEqual({ pushId: 'push_01' });
        expect(r.isError).toBeUndefined();
    });
});

describe('errorResult', () => {
    it('marks isError true and serializes the payload', () => {
        const r = errorResult({ error: 'X', message: 'm' });
        expect(r.isError).toBe(true);
        expect(parseFirstText(r as { content: Array<{ type: string; text: string }> })).toEqual({
            error: 'X',
            message: 'm',
        });
    });
});

describe('hookNotConfiguredError', () => {
    it('returns HOOK_NOT_CONFIGURED with a settings suggestion', () => {
        const r = hookNotConfiguredError();
        expect(r.isError).toBe(true);
        const body = parseFirstText(r as { content: Array<{ type: string; text: string }> });
        expect(body.error).toBe('HOOK_NOT_CONFIGURED');
        expect(body.suggestion).toMatch(/ZEPH_HOOK_ID/);
    });
});

describe('timeoutError', () => {
    it('encodes the elapsed seconds and a caller-supplied suggestion', () => {
        const r = timeoutError(120, 'try again');
        const body = parseFirstText(r as { content: Array<{ type: string; text: string }> });
        expect(body.error).toBe('TIMEOUT');
        expect(body.message).toContain('120 seconds');
        expect(body.suggestion).toBe('try again');
    });
});

describe('formatToolError', () => {
    it('passes through ApiError code + message', () => {
        const err = new ApiError('boom', 'SOMETHING_BAD', 500);
        const r = formatToolError(err);
        const body = parseFirstText(r as { content: Array<{ type: string; text: string }> });
        expect(body.error).toBe('SOMETHING_BAD');
        expect(body.message).toBe('boom');
    });

    it('adds QUOTA_EXCEEDED upgrade suggestion', () => {
        const err = new ApiError('over limit', 'QUOTA_EXCEEDED', 403);
        const body = parseFirstText(formatToolError(err) as { content: Array<{ type: string; text: string }> });
        expect(body.suggestion).toMatch(/Upgrade/);
    });

    it('adds UNAUTHORIZED → check ZEPH_API_KEY suggestion', () => {
        const err = new ApiError('nope', 'UNAUTHORIZED', 401);
        const body = parseFirstText(formatToolError(err) as { content: Array<{ type: string; text: string }> });
        expect(body.suggestion).toMatch(/ZEPH_API_KEY/);
    });

    it('adds HOOK_DISABLED → enable in settings suggestion', () => {
        const err = new ApiError('disabled', 'HOOK_DISABLED', 400);
        const body = parseFirstText(formatToolError(err) as { content: Array<{ type: string; text: string }> });
        expect(body.suggestion).toMatch(/Enable the Hook/);
    });

    it('adds FORBIDDEN → check scopes suggestion', () => {
        const err = new ApiError('forbidden', 'FORBIDDEN', 403);
        const body = parseFirstText(formatToolError(err) as { content: Array<{ type: string; text: string }> });
        expect(body.suggestion).toMatch(/push:write/);
    });

    it('handles unknown Error subclasses as UNKNOWN', () => {
        const err = new Error('something else');
        const body = parseFirstText(formatToolError(err) as { content: Array<{ type: string; text: string }> });
        expect(body.error).toBe('UNKNOWN');
        expect(body.message).toBe('something else');
    });

    it('handles non-Error throws by stringifying', () => {
        const body = parseFirstText(formatToolError('plain string') as { content: Array<{ type: string; text: string }> });
        expect(body.error).toBe('UNKNOWN');
        expect(body.message).toBe('plain string');
    });
});
