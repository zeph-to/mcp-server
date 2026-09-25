import { hostname } from 'os';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZephApiClient } from '../api-client.js';
import { textResult, formatToolError, errorResult } from '../error-format.js';
import type { McpServerConfig } from '../config.js';
import { AgentTargetError, resolveAgentTarget } from '../agent-target.js';
import type { DeviceRecord } from '../types.js';

/**
 * The header the receiving agent reads first: who sent this and the key to
 * answer on. The CLI builds the same shape (cli/src/send.ts) and the web app is
 * to parse it to caption the bubble, so a change here changes three repos. The
 * reply key is offered only for a session the listener reports, and never for a
 * subagent: `resolveAgentTarget` takes neither, so the reply would not resolve.
 */
const senderHeader = (devices: DeviceRecord[], config: McpServerConfig): { header: string; ownKey?: string } => {
  const { agentDeviceId, agentSessionName } = config;
  const own = devices.find((d) => d.deviceId === agentDeviceId);
  const host = own?.nickname ?? hostname();
  const listed = !!agentSessionName && !!own?.agentSessions?.some((s) => s.name === agentSessionName && !s.parentName);
  if (!agentDeviceId || !agentSessionName || !listed) {
    return { header: `[from ${agentSessionName ?? config.projectName}@${host}]` };
  }
  const ownKey = `${agentDeviceId}:${agentSessionName}`;
  const label = own?.agentSessionAliases?.[agentSessionName] ?? agentSessionName;
  return { header: `[from ${label}@${host} · reply: ${ownKey}]`, ownKey };
};

export const registerAgentSendTool = (
  server: McpServer,
  client: Pick<ZephApiClient, 'listDevices' | 'sendPush'>,
  config: McpServerConfig,
) => {
  server.registerTool(
    'zeph_agent_send',
    {
      description:
        "Type a message into ANOTHER agent session on any of the user's machines, as if the user sent it from their phone. " +
        'Use when the user asks you to pass something to another agent. ' +
        'The receiver sees `[from <you>@<host> · reply: <your key>]` first. ' +
        'Answer such a message with this tool only when it asks for an answer — two agents replying to each other loop.',
      annotations: {
        readOnlyHint: false,
        // It types into another agent, which may act on it: never auto-approve.
        destructiveHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        target: z
          .string()
          .trim()
          .min(1)
          .describe('Session key `<deviceId>:<tmuxName>` as given in a `[zeph: …]` hint or `reply:` header, or a name/alias matching one session'),
        message: z.string().trim().min(1).describe('Plain text (not encrypted) typed into the target session'),
      },
    },
    async ({ target, message }) => {
      try {
        const { data: devices } = await client.listDevices();
        const { header, ownKey } = senderHeader(devices, config);
        const resolved = resolveAgentTarget(devices, target, ownKey);
        if (resolved.key === ownKey) {
          return errorResult({ error: 'SELF_TARGET', message: 'The target is this session itself — pick another agent.' });
        }
        // Plaintext on purpose: the listener drops an encrypted agent.command
        // (cli listener.ts `handlePush`). No agentDeviceId either — the server
        // groups by `agentDeviceId ?? targetDeviceId`, so it would file the push
        // under a chat that is not the target's.
        const result = await client.sendPush({
          type: 'agent.command',
          targetDeviceId: resolved.deviceId,
          agentSessionName: resolved.name,
          body: `${header} ${message}`,
        });
        return textResult({ sent: true, target: resolved.key, pushId: result.data.pushId });
      } catch (err) {
        if (err instanceof AgentTargetError) {
          return errorResult({ error: err.code, message: err.message });
        }
        return formatToolError(err);
      }
    },
  );
};
