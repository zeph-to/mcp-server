# @zeph-to/mcp-server

Zeph MCP server for AI agents. Send notifications, copy to clipboard, request confirmations, and collect text input from users across their devices — all via the [Model Context Protocol](https://modelcontextprotocol.io).

## Setup

The easiest way to set up for all agents at once:

```bash
npx @zeph-to/hook-sdk install
```

This saves credentials to `~/.zeph/config.json` and configures your agents automatically. The MCP server reads from this file — no env vars needed.

### Claude Code (manual)

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "zeph": {
      "command": "npx",
      "args": ["-y", "@zeph-to/mcp-server"],
      "env": {
        "ZEPH_API_KEY": "ak_...",
        "ZEPH_HOOK_ID": "hook_...",
        "ZEPH_DEVICE_ID": "dev_..."
      }
    }
  }
}
```

### Cursor / Other MCP Clients

```json
{
  "command": "npx",
  "args": ["-y", "@zeph-to/mcp-server"],
  "env": {
    "ZEPH_API_KEY": "ak_..."
  }
}
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ZEPH_API_KEY` | Yes* | API key from Settings > API Keys |
| `ZEPH_HOOK_ID` | No | Hook ID for interactive tools (`zeph_prompt`, `zeph_input`) |
| `ZEPH_DEVICE_ID` | No | Target device ID. Omit to send to all devices |
| `ZEPH_BASE_URL` | No | API base URL (default: `https://api.zeph.to/v1`) |

\* All env vars fall back to `~/.zeph/config.json` if not set or if the value is an unresolved `${...}` interpolation.

## Tools

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
| Need user decision | `zeph_prompt` | Choose deploy target, confirm destructive action |
| Need free-form input | `zeph_input` | Commit message, env var value, description |
| Share code/logs | `zeph_file` | Error logs, test reports, generated config |
| Share snippet | `zeph_clipboard` | API key, URL, shell command |

### Recommended patterns

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
- `hook:write` — for `zeph_prompt` and `zeph_input`
- `channel:read` — for `zeph://channels` resource

Create an API key with the **MCP** preset in Settings > API Keys for the correct permissions.

## License

Apache-2.0
