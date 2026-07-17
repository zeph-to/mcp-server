# @zeph-to/mcp-server

[![npm](https://img.shields.io/npm/v/@zeph-to/mcp-server.svg)](https://www.npmjs.com/package/@zeph-to/mcp-server)
[![downloads](https://img.shields.io/npm/dm/@zeph-to/mcp-server.svg)](https://www.npmjs.com/package/@zeph-to/mcp-server)
[![node](https://img.shields.io/node/v/@zeph-to/mcp-server.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@zeph-to/mcp-server.svg)](./LICENSE)

**Your agent calls `zeph_ask`; the question lands on your phone as buttons + a text field; your reply comes back into the same tool call and the agent keeps going.**

Zeph's MCP server is the agent side of that round trip — plus one-way notifications, clipboard, files, and channel broadcasts, all over the [Model Context Protocol](https://modelcontextprotocol.io). Works with Claude Code, Cursor, Windsurf, Gemini CLI, and any MCP client.

<p align="center">
  <img src="https://zeph.to/readme/demo.gif" alt="Agent calls zeph_ask; the question hits the phone; you tap Deploy; the tool call returns" width="560"><br>
  <sub><em>Your agent calls <code>zeph_ask</code> → the question hits your phone → you tap <b>Deploy</b> → the call returns and the agent ships.</em></sub>
</p>

Part of the Zeph toolchain: [`@zeph-to/cli`](https://github.com/zeph-to/cli) (installer, push CLI, tmux remote control) · [`zeph-to/plugin`](https://github.com/zeph-to/plugin) (Claude Code plugin bundling this server) · the [Zeph app](https://zeph.to) on your phone.

## Setup

The easiest way to set up for all agents at once:

```bash
npm install -g @zeph-to/cli
zeph install
```

This saves credentials to `~/.zeph/config.json` and configures your agents automatically. The MCP server reads from this file — no env vars needed. Install globally so `zeph cc` (phone-driven sessions) works and hooks skip an npx cold-start; `npx @zeph-to/cli install` is a notifications-only alternative.

### Claude Code (manual)

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "zeph": {
      "command": "npx",
      "args": ["-y", "@zeph-to/mcp-server"]
    }
  }
}
```

No `env` block needed: credentials come from `~/.zeph/config.json` (written
by `zeph install`). Add env vars only to override the file —
e.g. a second account:

```json
      "env": { "ZEPH_API_KEY": "ak_other_account" }
```

### Cursor / Other MCP Clients

```json
{
  "command": "npx",
  "args": ["-y", "@zeph-to/mcp-server"]
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZEPH_API_KEY` | Yes* | API key from Settings > API Keys |
| `ZEPH_HOOK_ID` | No | Hook ID (optional — only needed for interactive tools like `zeph_ask`/`zeph_prompt`/`zeph_input`) |
| `ZEPH_DEVICE_ID` | No | Target device ID (optional — only needed for interactive tools like `zeph_ask`/`zeph_prompt`/`zeph_input`). Omit to send to all devices |
| `ZEPH_BASE_URL` | No | API base URL (default: `https://api.zeph.to/v1`) |
| `ZEPH_WS_URL` | No | WebSocket endpoint for the hook-response fast path — `zeph_ask`/`zeph_prompt`/`zeph_input` answers arrive the moment the user submits them instead of on the next poll. Falls back to pure polling when unset. Also read from `wsUrl` in `~/.zeph/config.json` |
| `ZEPH_DISABLE_SESSION_CACHE` | No | Set to `1`/`true` to skip writing the session-id handoff file under `~/.cache/zeph/`. Useful for read-only filesystems, ephemeral CI runners, or sandboxed envs that audit filesystem writes. The plugin's stop hook still works without it (transcript-path UUID extraction is the primary path; the cache is a fallback for older Claude Code versions). |
| `ZEPH_SESSION_ID` | No | Override the session id attached to pushes (grouping in the app). Auto-detected from the newest Claude Code transcript when unset |
| `ZEPH_DISABLE_ENCRYPTION` | No | Set to `1`/`true` to force E2E-style push encryption off, even when the account has keys. Useful while cleaning up legacy key state |

\* If env vars are not set, the server reads from `~/.zeph/config.json` (created by `zeph install`). Unresolved `${...}` interpolations are also treated as unset.

## Tools

Push titles are automatically prefixed with the project directory name — `myapp · Build complete` — so the phone feed stays scannable when several sessions push at once.

### zeph_notify

Send a one-way push notification. Supports optional URL (auto-switches to link type).

```
title:          "Build complete"
body:           "All 42 tests passed"
url:            "https://github.com/org/repo/actions/runs/123"  (optional)
priority:       "low" | "normal" | "high" | "urgent"
targetDeviceId: "dev_..."  (optional, overrides ZEPH_DEVICE_ID)
```

### zeph_clipboard

Copy text to the user's device clipboard.

```
text:           "npm install @zeph-to/mcp-server"
targetDeviceId: "dev_..."  (optional)
```

### zeph_list

List recent push notifications.

```
limit: 5         (1-20, default: 5)
type:  "note"    (optional filter: note, link, file, clipboard, hook)
```

Returns: `{ pushes: [...], total: 5, hasMore: true }`

### zeph_dismiss

Mark a specific push as read.

```
pushId: "push_01HX..."
```

### zeph_dismiss_all

Clear all notifications at once. No parameters.

Returns: `{ dismissed: 12, badge: 0 }`

### zeph_broadcast

Send a notification to all subscribers of a channel.

```
channelId: "ch_..."
title:     "Deploy complete"
body:      "v2.1.0 is live"
url:       "https://..."  (optional)
priority:  "normal"
```

### zeph_file

Send a text file to the user's device.

```
fileName:       "report.json"
content:        "{\"status\": \"ok\"}"
title:          "Build Report"  (optional, defaults to fileName)
targetDeviceId: "dev_..."       (optional)
```

Returns: `{ pushId: "...", fileKey: "...", fileSize: 42 }`

### zeph_prompt

Ask the user to choose from 2-4 options. Blocks until response or timeout.

Requires `ZEPH_HOOK_ID`.

```
title:    "Deploy to production?"
body:     "3 migrations pending"
actions:  [{ id: "yes", label: "Deploy", style: "primary" },
           { id: "no",  label: "Cancel", style: "danger" }]
timeout:  120        (seconds, default: 120, max: 300)
fallback: "no"       (auto-select on timeout, optional)
```

Returns: `{ actionId: "yes", timedOut: false }`

### zeph_ask

Ask the user a question with optional quick-reply buttons and a text input field. Combines prompt (buttons) and input (text) in a single notification. Blocks until response or timeout.

Requires `ZEPH_HOOK_ID`.

<p align="center">
  <img src="https://zeph.to/readme/ask-phone.png" alt="zeph_ask rendered on the phone: a question with tappable answer buttons and a text field" width="300">
</p>

```
title:       "What should we do?"
body:        "3 tests failed in auth module"  (optional)
actions:     [{ id: "fix", label: "Fix now", style: "primary" },
              { id: "skip", label: "Skip", style: "secondary" }]  (optional, 1-4)
placeholder: "Or type a custom response..."  (optional)
inputType:   "text" | "multiline"  (default: text)
timeout:     120    (seconds, default: 120, max: 600)
fallback:    "skip" (auto-select on timeout, optional)
```

Returns: `{ actionId: "fix", timedOut: false }` or `{ value: "custom text", timedOut: false }`

### zeph_input

Request free-form text input from the user. Blocks until response or timeout.

Requires `ZEPH_HOOK_ID`.

```
title:       "Commit message"
body:        "Summarize the changes"
placeholder: "feat: ..."
inputType:   "text" | "password" | "multiline"
timeout:     120    (seconds, default: 120, max: 600)
```

Returns: `{ value: "feat: add clipboard sync", timedOut: false }`

### Client timeouts

`zeph_ask`, `zeph_prompt`, and `zeph_input` block until the user responds, up to their `timeout` (max 600s). With `ZEPH_WS_URL` configured the response arrives over WebSocket the instant it's submitted; otherwise the server polls. Either way the MCP request stays open the whole time. To keep the client from giving up early, the server emits a `notifications/progress` every 5s while waiting. Clients must either set a per-request timeout above the tool's `timeout`, or reset their timeout on progress notifications. Claude Code does the latter by default.

## Resources

### zeph://devices

Lists connected devices with online status. Use to check which devices will receive notifications.

### zeph://channels

Lists channels the user owns or subscribes to. Use to find `channelId` for `zeph_broadcast`.

## Usage Guide

### When to use each tool

| Situation | Tool | Example |
|-----------|------|---------|
| Long task finished | `zeph_notify` | Build complete, test results, deploy done |
| Need a decision (buttons + optional free text) | `zeph_ask` | "Tests green. Deploy?" with a custom-instruction escape hatch |
| Decision from fixed options only | `zeph_prompt` | Choose deploy target, confirm destructive action |
| Free-form input only | `zeph_input` | Commit message, env var value, description |
| Share code/logs | `zeph_file` | Error logs, test reports, generated config |
| Share snippet | `zeph_clipboard` | API key, URL, shell command |

### Recommended patterns

**Decision gate with an escape hatch (preferred):**
```
zeph_ask(
  title: "Tests green. Deploy to production?",
  actions: [
    { id: "deploy", label: "Deploy", style: "primary" },
    { id: "hold", label: "Hold", style: "secondary" }
  ],
  placeholder: "Or tell me what to do instead...",
  fallback: "hold"
)
```

**Task completion notification:**
```
zeph_notify(
  title: "Build complete: web app",
  body: "All 42 tests passed. Bundle size: 1.2MB (-3%)"
)
```

**Decision gate in CI/deploy flow:**
```
zeph_prompt(
  title: "Deploy to production?",
  body: "3 migrations pending. Last deploy: 2h ago.",
  actions: [
    { id: "deploy", label: "Deploy", style: "primary" },
    { id: "staging", label: "Staging only", style: "secondary" },
    { id: "cancel", label: "Cancel", style: "danger" }
  ],
  fallback: "cancel"
)
```

**Collecting user input remotely:**
```
zeph_input(
  title: "Commit message",
  body: "Changed: hooks.ts, input.ts, prompt.ts",
  placeholder: "feat: ..."
)
```

**Error alert with link:**
```
zeph_notify(
  title: "CI failed: lint errors",
  body: "2 errors in src/auth.ts",
  url: "https://github.com/org/repo/actions/runs/456",
  priority: "high"
)
```

### When NOT to use

- Short responses the user can see immediately in the terminal
- Read-only operations (file search, code analysis)
- Every single tool call — only notify on meaningful milestones

### Multi-session workflow

When running multiple AI agent sessions in parallel, use `zeph_notify` to signal completion so the user knows which session finished without checking each terminal.

## API Key Permissions

The API key needs the following scopes:

- `push:read` — for `zeph_list`
- `push:write` — for `zeph_notify`, `zeph_clipboard`, `zeph_dismiss`, `zeph_dismiss_all`, `zeph_file`
- `hook:write` — for `zeph_ask`, `zeph_prompt`, and `zeph_input`
- `channel:read` — for `zeph://channels` resource

Create an API key with the **MCP** preset in Settings > API Keys for the correct permissions.

## Encryption

Push bodies are encrypted with AES-256-GCM. The wrapping key is derived via ECDH P-256 and synced across your own devices on first server startup so every device can read the same push. Toggle encryption in the Zeph app (Settings → Encryption); when disabled, the server sends plaintext. No configuration needed.

**Threat model honesty:** keys are persisted on the Zeph backend to enable cross-device sync, so this is *device-shared* encryption — not true end-to-end. It protects push contents from passive network observers and from a leaked database snapshot taken without the key store, but it does **not** protect against the Zeph backend itself (it has the keys it serves to your devices). A true E2E mode (per-device keypairs, server stores only public keys, no key escrow) is on the roadmap.

## License

Apache-2.0
