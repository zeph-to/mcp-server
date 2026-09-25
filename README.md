# @zeph-to/mcp-server

[![npm](https://img.shields.io/npm/v/@zeph-to/mcp-server.svg)](https://www.npmjs.com/package/@zeph-to/mcp-server)
[![downloads](https://img.shields.io/npm/dm/@zeph-to/mcp-server.svg)](https://www.npmjs.com/package/@zeph-to/mcp-server)
[![node](https://img.shields.io/node/v/@zeph-to/mcp-server.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@zeph-to/mcp-server.svg)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-docs.zeph.to-1f6feb)](https://docs.zeph.to)

**Your agent calls `zeph_ask`; the question lands on your phone as buttons + a text field; your reply comes back into the same tool call and the agent keeps going.**

Zeph's MCP server is the agent side of that round trip — plus one-way notifications, clipboard, files, and channel broadcasts, all over the [Model Context Protocol](https://modelcontextprotocol.io). Works with Claude Code, Cursor, Windsurf, Gemini CLI, and any MCP client.

<p align="center">
  <img src="https://zeph.to/readme/demo.gif" alt="Agent calls zeph_ask; the question hits the phone; you tap Deploy; the tool call returns" width="560"><br>
  <sub><em>Your agent calls <code>zeph_ask</code> → the question hits your phone → you tap <b>Deploy</b> → the call returns and the agent ships.</em></sub>
</p>

Part of the Zeph toolchain: [`@zeph-to/cli`](https://github.com/zeph-to/cli) (installer, push CLI, tmux remote control) · [`zeph-to/plugin`](https://github.com/zeph-to/plugin) (Claude Code plugin bundling this server) · the [Zeph app](https://zeph.to) on your phone.

> **New here?** [docs.zeph.to](https://docs.zeph.to) walks the whole setup — one command on your machine, the app on your phone, and a restart. The reference below assumes that is already done.

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
| `ZEPH_HOOK_ID` | No | Hook ID (optional — only needed for `zeph_ask`) |
| `ZEPH_DEVICE_ID` | No | Target device ID (optional — only needed for `zeph_ask`). Omit to send to all devices |
| `ZEPH_BASE_URL` | No | API base URL (default: `https://api.zeph.to/v1`) |
| `ZEPH_WS_URL` | No | **Deprecated.** WebSocket endpoint for the hook-response fast path. `wsUrl` in `~/.zeph/config.json` wins over it and is where the value belongs; this is read only when the file has none, so a machine that predates the config field keeps working. It will stop being read |
| `ZEPH_DISABLE_SESSION_CACHE` | No | Set to `1`/`true` to skip writing the session-id handoff file under `~/.cache/zeph/`. Useful for read-only filesystems, ephemeral CI runners, or sandboxed envs that audit filesystem writes. The plugin's stop hook still works without it (transcript-path UUID extraction is the primary path; the cache is a fallback for older Claude Code versions). |
| `ZEPH_SESSION_ID` | No | Override the session id attached to pushes (grouping in the app). Auto-detected from the newest Claude Code transcript when unset |
| `ZEPH_DISABLE_ENCRYPTION` | No | Set to `1`/`true` to force push encryption off even when the account has it enabled. A local override for debugging what the server actually received — encryption is already off unless the account opted in (see [Encryption](#encryption)) |

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

Send a file to the user's device. Either `filePath` (a file already on disk) or
`content` (text you generated) is required.

```
filePath:       "/abs/path/screenshot.png"  (images, PDFs, logs — anything on disk)
content:        "{\"status\": \"ok\"}"       (text only; requires fileName)
fileName:       "report.json"               (required with content; defaults to basename of filePath)
title:          "Build Report"              (optional, defaults to fileName)
targetDeviceId: "dev_..."                   (optional)
```

Images are delivered with their real mime type and render inline on the device.
Never base64 a binary file into `content` — pass `filePath` and the server reads
the bytes off disk.

Returns: `{ pushId: "...", fileKey: "...", fileSize: 42, encrypted: true, delivery: "Sent via cloud" }`

**Always the cloud.** A file an agent sends goes through Zeph, whatever network
the target is on, and the result says `delivery: "Sent via cloud"`. The direct
hand-over of ADR-0013 belongs to the phone's share sheets, where a person picks
the route for a file they chose; an agent writing a report has no such consent
to read from, and a copy in the cloud is the one every device on the account
can open later.

### zeph_session_rename

Set a custom display name for the **current** agent session, shown in the Zeph app's **Streams › Agents** list. Lets an agent label what it's working on — `"Prod deploy"`, `"Auth refactor"` — so parallel sessions are easy to tell apart on your phone. Renames the session this server runs in (resolved from the listener device id + tmux session name); the name persists until changed.

```
alias: "Prod deploy watcher"   (1-60 chars)
```

Returns: `{ renamed: true, session: "zeph-myapp", alias: "Prod deploy watcher" }`, or `{ renamed: false, reason: "..." }` when there's no active session to rename (not running inside a `zeph listener` tmux session).

### zeph_agent_send

Type a message into **another** agent session — Claude Code, Codex, pi, … on any of the user's machines — as if the user had sent it from their phone. It shows in that session's chat in the app, and, like any command from the phone, puts that session in remote mode.

```
target:  "dev_listener_ab12cd34:zeph-api"   session key <deviceId>:<tmuxName>, or a name/alias that names one session
message: "Build is green on main — rebase and rerun the e2e suite"
```

The receiver reads `[from <your alias or tmux name>@<your machine> · reply: <your key>] <message>`, so it can answer with the same tool. A name also matches the alias, the name the agent gives its session, or its label. Your own session is left out of name matching, so a project you run on two PCs resolves to the other one. A name that still matches two sessions is refused with both keys listed, and an unknown name is refused with the other sessions listed. A session on a machine that is offline is refused (`TARGET_OFFLINE`): its listener takes commands only while connected, so the message would never be typed. Sending to your own session is refused. The body is plaintext, even with E2E on: the listener drops an encrypted `agent.command` instead of typing it. Keep secrets out of the message.

Returns: `{ sent: true, target: "<key>", pushId: "..." }`.

### zeph_ask

Ask the user a question with quick-reply buttons and a text input field — they tap a button or type. Blocks until response or timeout. With no `actions` it is a plain text prompt (a commit message, a value).

`actions` is the steering surface: pass 2–4 buttons on nearly every ask (the next-step candidates plus a safe Done-like `fallback`) and leave it out only when the answer is inherently free-form text — a bare text box on a "done — what next?" ask gives the phone nothing to tap.

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

The user can also attach screenshots or files to their answer. Those are downloaded to `~/.zeph/attachments/hook-<eventId>/` and the result gains an `attachments` array of absolute local paths, alongside the button or the text:

```
{ value: "look at this", attachments: ["/Users/you/.zeph/attachments/hook-hevt_1/screen.png"],
  attachmentsNote: "The user attached 1 file(s) to this answer. Read each path above to see them.",
  timedOut: false }
```

Reading those paths is part of reading the answer. Note that hook attachments are never end-to-end encrypted — the same limitation as the question itself, since the hook route carries no sender key.

### Client timeouts

`zeph_ask` blocks until the user responds, up to its `timeout` (max 600s). With `wsUrl` set in `~/.zeph/config.json` the response arrives over WebSocket the instant it's submitted; otherwise the server polls. Either way the MCP request stays open the whole time. To keep the client from giving up early, the server emits a `notifications/progress` every 5s while waiting. Clients must either set a per-request timeout above the tool's `timeout`, or reset their timeout on progress notifications. Claude Code does the latter by default.

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
| Free-form input only | `zeph_ask` without `actions` | Commit message, env var value, description |
| Share code/logs | `zeph_file` | Error logs, test reports, generated config |
| Share snippet | `zeph_clipboard` | API key, URL, shell command |
| Label this session | `zeph_session_rename` | Name the run "Prod deploy" so parallel sessions stay distinguishable on the phone |
| Pass work to another agent | `zeph_agent_send` | "Send the summary to the pi session on my other PC" |

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
- `push:write` — for `zeph_notify`, `zeph_clipboard`, `zeph_dismiss`, `zeph_dismiss_all`, `zeph_file`, `zeph_agent_send`
- `hook:write` — for `zeph_ask`
- `device:write` — for `zeph_session_rename`
- `channel:read` — for `zeph://channels` resource

Create an API key with the **MCP** preset in Settings > API Keys for the correct permissions.

## Encryption

End-to-end encryption is **off by default** and turning it on needs Zeph Pro. The switch is in the app under Settings → E2E Encryption; until you flip it, every push leaves this server in plaintext. If the account later loses Pro the server answers `PRO_REQUIRED` and this one drops back to plaintext for the rest of the process. No configuration either way — but the opt-in is read **once at startup**, so turning it on while this server is running takes effect only after a restart.

With it on, push bodies and file attachments are encrypted with AES-256-GCM. Only `zeph_notify` and `zeph_file` are encrypted. `zeph_ask`, `zeph_clipboard`, `zeph_broadcast` and `zeph_agent_send` stay plaintext even then — `zeph_agent_send` because the target machine's listener drops an encrypted `agent.command` instead of typing it. This machine holds one ECDH P-256 keypair in `~/.zeph/device-keys.json`, shared with `zeph listener` (which registers its public half on the machine's device record) and created by whichever starts first (the keypair older builds kept in `~/.config/zeph/device-keys.json` is deleted) — the private half never leaves the machine, and the backend stores public keys only and rejects a private-key upload. Each push is encrypted once, and its AES key is wrapped separately for every device on your account using ECDH against that device's public key.

**Threat model:** against a passive backend — a leaked snapshot, an operator reading the table — the stored ciphertext and wrapped keys are useless, so push contents stay private. Three limits worth knowing:
- **No protection from an active malicious operator.** Recipient public keys come from `GET /devices` on that same server, unsigned and unpinned. A backend that injects a device record carrying its own key gets the message key wrapped for it, and reads everything. The Zeph app ships the counter-measure — compare device fingerprints, mark a device verified, and strict mode then wraps only for verified devices — but it defaults off, its verified list is per browser profile, and this server does not consult it: `selectRecipients` asks only whether a device has a public key, and whether that key is the legacy account-wide one (ADR-0007 Phase 4).
- **No forward secrecy.** The ECDH secret for a given sender/device pair is static, so compromising either private key opens every past push wrapped for that pair.
- **`senderPublicKey` is unsigned**, so a swapped one makes a push undecryptable — that direction fails closed rather than leaking.

A device that has not registered a per-device public key cannot be sent to; it is skipped, and if no device qualifies the push goes out in the clear rather than arriving as something nothing can open.

## License

Apache-2.0
