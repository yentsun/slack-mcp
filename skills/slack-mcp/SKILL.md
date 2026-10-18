---
name: slack-mcp
description: Read and write Slack through yt-slack-mcp — read permalinks, threads, channel history, and attachments; reply in threads, react, upload files, and edit messages in allowed channels. Use when asked to inspect a Slack link, summarize a channel or thread, find recent channel messages, or post, reply, or edit in Slack.
---

# Slack MCP

Use the `yt-slack-mcp` MCP server through this skill. Read before writing, and
write only where the channel allow-list permits.

Server: `yt-slack-mcp` 0.5.0, launched as `npx yt-slack-mcp` over stdio.

## Setup and auth

The server talks to Slack through your logged-in browser session, not a bot
token.

1. Save the `xoxc` token (Slack web localStorage) as a single line in
   `~/.config/yt-slack-mcp/secrets/slack-xoxc.txt`.
2. Save the `xoxd` token (the cookie named `d`) as a single line in
   `~/.config/yt-slack-mcp/secrets/slack-xoxd.txt`.
3. Allow writes by listing channel IDs in `allowedWriteChannels` in
   `~/.config/yt-slack-mcp/config.json`. With an empty or missing list, every
   write is refused.

Configuration is file-based: `config.json` also accepts `secretsDir`, `xoxcPath`,
`xoxdPath`, and `userAgent`, and the defaults apply when a key is absent. Never
echo a token or a file's contents back to the user.

### What each failure means

| Message | Cause | Fix |
|---------|-------|-----|
| `Error: missing slack-xoxc.txt (looked at <path>)` | The `xoxc` file is absent at startup; the server exits before listing tools. | Write the token file at the reported path, or set `xoxcPath` in `config.json` to point at it. |
| `Error: missing slack-xoxd.txt (looked at <path>)` | Same, for the `xoxd` file. | Write the token file at the reported path, or set `xoxdPath` in `config.json` to point at it. |
| `Error: invalid Slack MCP config <path>: <detail>` | `config.json` is not valid JSON. | Fix the JSON or remove the file. |
| `Error: writes are not allowed for channel <id>` | The channel is not in the allow-list. | Add the channel ID to the allow-list if the user wants writes there; never work around the refusal. |
| `slack <method> failed: invalid_auth` (or `not_authed`) | The browser session expired or the token was copied incorrectly. | Refresh the `xoxc`/`xoxd` pair, then retry once. |
| `Error: missing <name>` | A required argument (`channel_id`, `thread_ts`, `timestamp`, `text`, `reaction`) was blank. | Supply the actual value; do not invent IDs. |

Tool errors arrive as text starting with `Error:`. Report the text instead of
retrying the same call unchanged.

## Troubleshooting

- **Writes refused or tokens missing after an upgrade.** Configuration is
  file-based only: values supplied through environment variables are ignored.
  Move `secretsDir`, `xoxcPath`, `xoxdPath`, and `allowedWriteChannels` into
  `~/.config/yt-slack-mcp/config.json`.
- **Only some expected channels are writable.** `allowedWriteChannels` is the
  complete list with no additive default; compare it with the channel IDs the
  user expects.
- **The server exits at startup.** The reported token path must exist and hold a
  non-empty single-line token. A stale browser session surfaces later as
  `invalid_auth`, not as a startup error.
- **A write still fails inside an allowed channel.** The browser session may have
  lost write access or the message may be outside the edit window; report the
  exact `Error:` text instead of retrying.

## Tool map

Choose the read tool from what the user gave you, and the write tool from the
action they asked for.

| Tool | Use it when |
|------|-------------|
| `slack_read_permalink` | A Slack link is the input. Reads the linked message's thread, including inline images, PDF text, and text attachments. |
| `slack_get_replies` | You have a channel ID and thread timestamp and need that thread again or its latest replies. |
| `slack_get_history` | There is no link or thread: read recent messages in a channel, such as "what happened in #ops today". |
| `slack_reply_to_thread` | Post a reply into an existing thread. Requires `channel_id`, `thread_ts`, `text`, and preferably `model`. |
| `slack_add_reaction` | Mark or acknowledge a message without posting text. |
| `slack_remove_reaction` | Remove a reaction this account added. |
| `slack_upload_files` | Post up to 10 local files (10 MB each) to a channel or thread, with an optional `initial_comment`. |
| `slack_edit_message` | Correct a message this account already posted, by channel ID and timestamp. |

The server has no plain top-level text post; a reply needs an existing thread.
A file upload with an `initial_comment` is the only way to start a new top-level
message. Say so instead of promising a text post.

## Recipes

### Read a permalink and reply in its thread

1. Call `slack_read_permalink` with the `url`.
2. Take the channel ID from the permalink and the root `[ts]` from the first
   returned message.
3. Read the whole thread before answering; do not repost what is already there.
4. Call `slack_reply_to_thread` with `channel_id`, `thread_ts`, `text`, and
   `model` set to the model you are running.

### Summarize a channel

1. Call `slack_get_history` with `channel_id` and `limit` up to 200.
2. Summarize in the conversation, quoting `[ts]` values when the user needs to
   locate a message.
3. Post the summary only when asked, and only as a reply in a relevant thread or
   as a file upload's `initial_comment`; there is no plain top-level text post.

### Upload a file with a comment

1. Resolve absolute local paths; at most 10 files, 10 MB each.
2. Call `slack_upload_files` with `file_paths`, `channel_id`, an optional
   `thread_ts`, and `initial_comment` when a message should accompany the files.
3. Pass `model`, which is used only when `initial_comment` is present; without a
   comment the upload stays comment-free.
4. Report the returned file and message permalinks.

### Correct a posted message

1. Call `slack_edit_message` with `channel_id`, the message `timestamp`, and the
   replacement `text`.
2. Leave `agent_authored` at its default for agent-written text; pass `model` so
   the prefix names the model.
3. Pass `agent_authored: false` only when replacing agent text with the user's own
   words, such as correcting their message; `model` is then ignored.
4. Slack removes existing Block Kit blocks on edit and only allows edits to this
   account's messages within its edit window.

## Guardrails

- Read before writing. Fetch the thread or channel context first, even when the
  requested text seems obvious.
- Stay inside the allow-list. Never attempt a write to a channel that is not
  listed, and never suggest disabling the check to "make it work".
- Pass `model` on every text-writing call — reply, upload with a comment, edit —
  so posts read `🤖 <model>:`. Never add the prefix yourself; the server adds it
  once.
- `agent_authored: false` is an explicit correction of non-agent text, not a
  default and not a way to hide that an agent posted.
- Prefer edits over reposting. Do not "fix" a message by posting it again.
