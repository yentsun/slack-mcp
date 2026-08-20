# yt-slack-mcp

MCP server for **Slack** — read permalinks, threads, and channel history; reply to threads; add reactions.

Implements the [Model Context Protocol](https://modelcontextprotocol.io) specification: it runs over the stdio transport, speaks JSON-RPC 2.0, negotiates the protocol version on `initialize`, advertises `tools` capabilities, and describes each tool with a JSON Schema. Protocol version negotiation is handled by the `@modelcontextprotocol/sdk` `Server` class, which defaults to the latest supported version.

## Tools

| Tool | Description |
|------|-------------|
| `slack_read_permalink` | Read a message or thread from a permalink (PDFs/images included) |
| `slack_get_replies` | Read replies for a thread by channel id + timestamp |
| `slack_get_history` | Read recent channel history |
| `slack_reply_to_thread` | Reply to a thread (restricted to allowed channels) |
| `slack_add_reaction` | Add a reaction (restricted to allowed channels) |

Read tools use the private Slack browser-session API (via `xoxc` / `xoxd` tokens), so they can pull private file contents — PDFs are downloaded and text-extracted (up to 50 pages / 100k chars), images are returned inline.

## Setup

### 1. Obtain browser session tokens

- `xoxc`: Slack web localStorage token (from your logged-in browser session).
- `xoxd`: Slack cookie named `d`.

These may need refreshing when Slack rotates/invalidates the session.

### 2. Place the secrets

Save each token as a single-line file:

```
~/.config/opencode/secrets/slack-xoxc.txt
~/.config/opencode/secrets/slack-xoxd.txt
```

Or override the paths via the config file or env vars.

### 3. (Optional) Configure allowed write channels and paths

All configuration can live in a JSON config file at
`~/.config/yt-slack-mcp/config.json` (override with `SLACK_MCP_CONFIG`):

```json
{
  "secretsDir": "~/.config/opencode/secrets",
  "xoxcPath": "~/.config/opencode/secrets/slack-xoxc.txt",
  "xoxdPath": "~/.config/opencode/secrets/slack-xoxd.txt",
  "allowedWriteChannels": ["C0123456789", "C0987654321"],
  "userAgent": "Mozilla/5.0"
}
```

By default the write tools (`slack_reply_to_thread`, `slack_add_reaction`)
are locked down — no channel is writable. Every field is optional; a
missing file just means defaults. Env vars always override the config file.

## Configuration

Config resolution order: built-in defaults → config file → env vars.

| Config file key | Env var | Default | Description |
|-----------------|---------|---------|-------------|
| `secretsDir` | `SLACK_MCP_SECRETS_DIR` | `~/.config/opencode/secrets` | Directory holding the token files |
| `xoxcPath` | `SLACK_MCP_XOXC_PATH` | `$SECRETS_DIR/slack-xoxc.txt` | Path to the `xoxc` token |
| `xoxdPath` | `SLACK_MCP_XOXD_PATH` | `$SECRETS_DIR/slack-xoxd.txt` | Path to the `xoxd` token |
| `allowedWriteChannels` | `SLACK_MCP_ALLOWED_WRITE_CHANNELS` | *(none)* | Channel IDs allowed for write tools (comma-separated in env) |
| `userAgent` | `SLACK_MCP_USER_AGENT` | `Mozilla/5.0` | HTTP `User-Agent` header |
| *(config file path)* | `SLACK_MCP_CONFIG` | `~/.config/yt-slack-mcp/config.json` | Path to the JSON config file |

## MCP host config

### opencode

```jsonc
{
  "mcp": {
    "slack": {
      "type": "local",
      "command": ["npx", "yt-slack-mcp"]
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["yt-slack-mcp"]
    }
  }
}
```

## License

MIT
