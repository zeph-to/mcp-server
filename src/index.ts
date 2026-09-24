#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { legacyWsEnvNotice, loadConfig } from './config.js';
import { initCrypto } from './crypto.js';
import { createServer } from './server.js';

const main = async () => {
  const config = loadConfig();

  // Read only to report: the variable used to outrank the config file, and
  // removing it without a word would leave the same silence behind.
  const staleWsEnv = legacyWsEnvNotice(config);
  if (staleWsEnv) console.error(staleWsEnv);

  // Load or create this host's keypair, if the account has opted in. Runs once
  // per process and caches, so toggling E2E in the app while this server is
  // running has no effect until it restarts.
  try {
    const publicKey = await initCrypto(config.apiKey, config.baseUrl);
    if (publicKey) console.error(`[Crypto] E2E encryption ready for zeph_notify / zeph_file (publicKey: ${publicKey.slice(0, 20)}...) — zeph_ask stays plaintext`);
    else console.error('[Crypto] E2E encryption off — enable it in the Zeph app, then restart this server.');
  } catch (err) {
    console.error('[Crypto] E2E encryption unavailable:', err);
  }

  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Zeph MCP Server running on stdio');
};

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
