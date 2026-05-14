#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { ZephApiClient } from './api-client.js';
import { initCrypto } from './crypto.js';
import { registerNotifyTool } from './tools/notify.js';
import { registerPromptTool } from './tools/prompt.js';
import { registerInputTool } from './tools/input.js';
import { registerClipboardTool } from './tools/clipboard.js';
import { registerListTool } from './tools/list.js';
import { registerDismissTool, registerDismissAllTool } from './tools/dismiss.js';
import { registerBroadcastTool } from './tools/broadcast.js';
import { registerFileTool } from './tools/file.js';
import { registerDevicesResource } from './resources/devices.js';
import { registerChannelsResource } from './resources/channels.js';

const getVersion = (): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
};

const createServer = () => {
  const config = loadConfig();
  const client = new ZephApiClient(config);

  const server = new McpServer(
    {
      name: 'zeph',
      version: getVersion(),
    },
    {
      instructions: [
        'Zeph MCP Server — Send notifications, files, clipboard text, broadcast to channels, manage push history, and interact with users across their devices.',
        '',
        'Available tools:',
        '- zeph_notify: Send push notifications with optional URL (task completion, errors, links)',
        '- zeph_clipboard: Copy text to user\'s device clipboard',
        '- zeph_list: List recent push notifications (history, deduplication)',
        '- zeph_dismiss: Mark a push as read',
        '- zeph_dismiss_all: Clear all notifications',
        '- zeph_broadcast: Send to all subscribers of a channel',
        '- zeph_file: Send a text file (logs, reports, code)',
        '- zeph_prompt: Ask user to choose from options (requires ZEPH_HOOK_ID)',
        '- zeph_input: Request text input from user (requires ZEPH_HOOK_ID)',
        '',
        'Resources:',
        '- zeph://devices: Check which devices are online',
        '- zeph://channels: List available channels for broadcasting',
      ].join('\n'),
    },
  );

  registerNotifyTool(server, client, config);
  registerClipboardTool(server, client, config);
  registerListTool(server, client);
  registerDismissTool(server, client);
  registerDismissAllTool(server, client);
  registerBroadcastTool(server, client);
  registerFileTool(server, client, config);
  registerPromptTool(server, client, config);
  registerInputTool(server, client, config);
  registerDevicesResource(server, client);
  registerChannelsResource(server, client);

  return server;
};

const main = async () => {
  // Initialize E2E encryption keys (load or generate)
  try {
    const publicKey = await initCrypto();
    console.error(`[Crypto] E2E encryption ready (publicKey: ${publicKey.slice(0, 20)}...)`);
  } catch (err) {
    console.error('[Crypto] E2E encryption unavailable:', err);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Zeph MCP Server running on stdio');
};

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
