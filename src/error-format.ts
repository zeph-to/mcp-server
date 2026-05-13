import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApiError } from './api-client.js';
import type { ToolError } from './types.js';

export const textResult = (obj: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
});

export const errorResult = (obj: ToolError): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  isError: true,
});

export const hookNotConfiguredError = (): CallToolResult =>
  errorResult({
    error: 'HOOK_NOT_CONFIGURED',
    message: 'ZEPH_HOOK_ID environment variable is not set',
    suggestion: 'Create a Hook in Settings → Hooks, then set ZEPH_HOOK_ID in your MCP server config',
  });

export const timeoutError = (seconds: number, suggestion: string): CallToolResult =>
  errorResult({
    error: 'TIMEOUT',
    message: `No response received within ${seconds} seconds`,
    suggestion,
  });

export const formatToolError = (err: unknown): CallToolResult => {
  const toolError: ToolError = {
    error: 'UNKNOWN',
    message: err instanceof Error ? err.message : String(err),
  };

  if (err instanceof ApiError) {
    toolError.error = err.code;
    toolError.message = err.message;

    if (err.code === 'QUOTA_EXCEEDED') {
      toolError.suggestion = 'Monthly quota exceeded. Upgrade plan for higher limits';
    } else if (err.code === 'UNAUTHORIZED') {
      toolError.suggestion = 'Check ZEPH_API_KEY environment variable or ~/.zeph/config.json';
    } else if (err.code === 'HOOK_DISABLED') {
      toolError.suggestion = 'Enable the Hook in Settings → Hooks';
    } else if (err.code === 'FORBIDDEN') {
      toolError.suggestion = 'Check API key permissions (needs push:write and hook:write)';
    }
  }

  return errorResult(toolError);
};
