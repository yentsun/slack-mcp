# yt-slack-mcp

A host-agnostic [Model Context Protocol](https://modelcontextprotocol.io) server for Slack. It communicates over stdio and can be used with any MCP client that launches local servers.

## Features

- Read Slack channel history and thread replies.
- Read message permalinks from channels, DMs, and group DMs.
- Return image attachments inline, extract text from PDFs, and return `text/*` attachment contents inline.
- Retrieve private attachment contents through the authenticated Slack browser session.
- Reply to a thread, add a reaction, edit an authored message or thread reply, or upload local files only in explicitly allowed channel IDs.

Attachment limits: images and text files are limited to 10 MB; text attachments are truncated at 100,000 characters. PDFs are limited to 20 MB, 50 pages, and 100,000 extracted characters.

## Tools

| Tool | Description |
|------|-------------|
| `slack_read_permalink` | Read a message or thread from a channel, DM, or group-DM permalink, including supported attachments. |
| `slack_get_replies` | Read replies for a thread by channel ID and timestamp. |
| `slack_get_history` | Read recent channel history. |
| `slack_reply_to_thread` | Reply to a thread; restricted to allowed channels. |
| `slack_add_reaction` | Add a reaction; restricted to allowed channels. |
| `slack_upload_files` | Upload up to 10 local files to a channel or thread, with an optional initial comment; returns file and message permalinks; restricted to allowed channels. |
| `slack_edit_message` | Edit an authored message or thread reply by channel ID and timestamp; replaces the message text (Slack removes any existing Block Kit blocks) and returns the updated timestamp and permalink; restricted to allowed channels. |

## Setup

### 1. Obtain browser session tokens

- `xoxc`: Slack web localStorage token (from your logged-in browser session).
- `xoxd`: Slack cookie named `d`.

These may need refreshing when Slack rotates/invalidates the session.

### 2. Store the secrets

Save each token as a single-line file:

```
~/.config/yt-slack-mcp/secrets/slack-xoxc.txt
~/.config/yt-slack-mcp/secrets/slack-xoxd.txt
```

The server reads these paths by default. Override them with the config file or environment variables if your MCP host manages secrets elsewhere.

### 3. (Optional) Configure allowed write channels and paths

All configuration can live in a JSON config file at
`~/.config/yt-slack-mcp/config.json` (override with `SLACK_MCP_CONFIG`):

```json
{
  "secretsDir": "~/.config/yt-slack-mcp/secrets",
  "xoxcPath": "~/.config/yt-slack-mcp/secrets/slack-xoxc.txt",
  "xoxdPath": "~/.config/yt-slack-mcp/secrets/slack-xoxd.txt",
  "allowedWriteChannels": ["C0123456789", "C0987654321"],
  "userAgent": "Mozilla/5.0"
}
```

By default the write tools (`slack_reply_to_thread`, `slack_add_reaction`,
`slack_edit_message`) and `slack_upload_files` are locked down — no channel is
writable. Each upload is limited to 10 MB. Every field is optional; a
missing file just means defaults. Env vars always override the config file.

## Configuration

Config resolution order: built-in defaults → config file → env vars.

| Config file key | Env var | Default | Description |
|-----------------|---------|---------|-------------|
| `secretsDir` | `SLACK_MCP_SECRETS_DIR` | `~/.config/yt-slack-mcp/secrets` | Directory holding the token files |
| `xoxcPath` | `SLACK_MCP_XOXC_PATH` | `$SECRETS_DIR/slack-xoxc.txt` | Path to the `xoxc` token |
| `xoxdPath` | `SLACK_MCP_XOXD_PATH` | `$SECRETS_DIR/slack-xoxd.txt` | Path to the `xoxd` token |
| `allowedWriteChannels` | `SLACK_MCP_ALLOWED_WRITE_CHANNELS` | *(none)* | Channel IDs allowed for write tools (comma-separated in env) |
| `userAgent` | `SLACK_MCP_USER_AGENT` | `Mozilla/5.0` | HTTP `User-Agent` header |
| *(config file path)* | `SLACK_MCP_CONFIG` | `~/.config/yt-slack-mcp/config.json` | Path to the JSON config file |

## MCP host configuration

Configure your MCP host to run `yt-slack-mcp` over stdio. The host-specific configuration varies, but the command is:

```
npx yt-slack-mcp
```

For example, Claude Desktop uses:

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
