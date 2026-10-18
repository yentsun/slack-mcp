# yt-slack-mcp

A host-agnostic [Model Context Protocol](https://modelcontextprotocol.io) server for Slack. It communicates over stdio and can be used with any MCP client that launches local servers.

## Features

- Read Slack channel history and thread replies.
- Read message permalinks from channels, DMs, and group DMs.
- Return image attachments inline, extract text from PDFs, and return `text/*` attachment contents inline.
- Retrieve private attachment contents through the authenticated Slack browser session.
- Reply to a thread, add or remove a reaction, edit an authored message or thread reply, or upload local files only in explicitly allowed channel IDs.
- Prefix every message the agent posts with `🤖:` — or `🤖 <model>:` when the call names the model — so agent replies stand apart from the account's own messages; an edit can opt out with `agent_authored: false`.

Attachment limits: images and text files are limited to 10 MB; text attachments are truncated at 100,000 characters. PDFs are limited to 20 MB, 50 pages, and 100,000 extracted characters.

## Tools

| Tool | Description |
|------|-------------|
| `slack_read_permalink` | Read a message or thread from a channel, DM, or group-DM permalink, including supported attachments. |
| `slack_get_replies` | Read replies for a thread by channel ID and timestamp. |
| `slack_get_history` | Read recent channel history. |
| `slack_reply_to_thread` | Reply to a thread, with optional `model`, in a `🤖:`-prefixed message; restricted to allowed channels. |
| `slack_add_reaction` | Add a reaction; restricted to allowed channels. |
| `slack_remove_reaction` | Remove a reaction added by this account; restricted to allowed channels. |
| `slack_upload_files` | Upload up to 10 local files to a channel or thread, with an optional `initial_comment` prefixed with `🤖:` and an optional `model` (only used with a comment); returns file and message permalinks; restricted to allowed channels. |
| `slack_edit_message` | Edit an authored message or thread reply by channel ID and timestamp; replaces the message text with `🤖:`-prefixed text and an optional `model`, or with the text as given when `agent_authored` is `false` (Slack removes any existing Block Kit blocks) and returns the updated timestamp and permalink; restricted to allowed channels. |

## Agent message prefix

The write tools post through the account's own browser session, so Slack shows
the account name on them. To keep agent-written messages distinguishable, the
text of every posted message is prefixed with `🤖:` by default:

```text
🤖: deployed revision 4f2c1a9
```

The MCP transport does not report which model is calling, so a write tool call
can pass `model` with the model it is running; the prefix then names it:

```text
🤖 claude-sonnet-4-5: deployed revision 4f2c1a9
```

The prefix is added once: text that already starts with `🤖` is sent unchanged,
so editing a prefixed message does not stack prefixes. A file upload without an
`initial_comment` — or with only whitespace — gets no comment rather than a bare
prefix, and `model` has no effect then.

`slack_edit_message` can also replace a message with text that is not
agent-written, such as a correction to the user's own message: pass
`agent_authored: false` and the text is stored as given, without the prefix.
`model` has no effect when `agent_authored` is `false`.

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

The server reads these paths by default. Override them in the config file described below if your MCP host manages secrets elsewhere.

### 3. (Optional) Configure allowed write channels and paths

All configuration lives in a JSON config file at
`~/.config/yt-slack-mcp/config.json`:

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
`slack_remove_reaction`, `slack_edit_message`) and `slack_upload_files` are
locked down — no channel is writable. Each upload is limited to 10 MB. Every
field is optional; a missing file just means defaults.

## Configuration

Configuration comes from the JSON config file, with built-in defaults for
absent keys.

| Config key | Default | Description |
|------------|---------|-------------|
| `secretsDir` | `~/.config/yt-slack-mcp/secrets` | Directory holding the token files |
| `xoxcPath` | `$SECRETS_DIR/slack-xoxc.txt` | Path to the `xoxc` token |
| `xoxdPath` | `$SECRETS_DIR/slack-xoxd.txt` | Path to the `xoxd` token |
| `allowedWriteChannels` | *(none)* | Channel IDs allowed for write tools |
| `userAgent` | `Mozilla/5.0` | HTTP `User-Agent` header |

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

## Install as a skill

[`skills/slack-mcp/SKILL.md`](skills/slack-mcp/SKILL.md) packages this server as
an Agent Skill so an agent knows when to read Slack, when a write is allowed,
and which tool fits the request. Copy or symlink the `skills/slack-mcp`
directory into your agent's skills directory (for example
`.agents/skills/slack-mcp`); the server still needs the setup above.

The skill is also prepared for the Agensi marketplace; the listing copy lives in
[`skills/slack-mcp/LISTING.md`](skills/slack-mcp/LISTING.md).

## License

MIT
