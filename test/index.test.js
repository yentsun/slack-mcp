import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
    parsePermalink,
    requireString,
    assertAllowedWriteChannel,
    ReadPermalinkSchema,
    GetRepliesSchema,
    GetHistorySchema,
    ReplyToThreadSchema,
    AddReactionSchema,
    RemoveReactionSchema,
    EditMessageSchema,
    TOOLS,
} from "../index.js";

test("tool definitions omit annotations unsupported by the OpenCode MCP catalog", () => {
    assert.ok(TOOLS.length > 0);
    for (const tool of TOOLS) {
        assert.equal(Object.hasOwn(tool, "annotations"), false, `${tool.name} must not include annotations`);
    }
});

test("stdio server completes the MCP lifecycle and lists compatible tools", async (t) => {
    const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-slack-mcp-secrets-"));
    fs.writeFileSync(path.join(secretsDir, "slack-xoxc.txt"), "xoxc-test");
    fs.writeFileSync(path.join(secretsDir, "slack-xoxd.txt"), "xoxd-test");

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["index.js"],
        cwd: process.cwd(),
        env: { ...process.env, SLACK_MCP_SECRETS_DIR: secretsDir },
        stderr: "pipe",
    });
    const client = new Client({ name: "yt-slack-mcp-test", version: "1.0.0" });

    t.after(async () => {
        await transport.close();
        fs.rmSync(secretsDir, { recursive: true, force: true });
    });

    await client.connect(transport);
    const { tools } = await client.listTools();

    assert.equal(tools.length, TOOLS.length);
    for (const tool of tools) {
        assert.equal(Object.hasOwn(tool, "annotations"), false, `${tool.name} must not include annotations`);
    }
});

test("parsePermalink extracts channel and timestamp", () => {
    const { channelId, timestamp } = parsePermalink(
        "https://example.slack.com/archives/C0123456789/p1234567890123456"
    );
    assert.equal(channelId, "C0123456789");
    assert.equal(timestamp, "1234567890.123456");
});

test("parsePermalink accepts direct-message and group-DM channels", () => {
    for (const channelId of ["D0123456789", "G0123456789"]) {
        const result = parsePermalink(
            `https://example.slack.com/archives/${channelId}/p1234567890123456`
        );
        assert.equal(result.channelId, channelId);
    }
});

test("parsePermalink rejects bad urls", () => {
    assert.throws(() => parsePermalink("https://example.com"), /invalid Slack permalink/);
});

test("requireString rejects missing / non-string values", () => {
    assert.throws(() => requireString(undefined, "x"), /missing x/);
    assert.throws(() => requireString("", "x"), /missing x/);
    assert.throws(() => requireString("  ", "x"), /missing x/);
    assert.equal(requireString(" hi ", "x"), "hi");
});

test("assertAllowedWriteChannel enforces allowlist", () => {
    const allowed = new Set(["C1"]);
    assert.doesNotThrow(() => assertAllowedWriteChannel("C1", allowed));
    assert.throws(() => assertAllowedWriteChannel("C2", allowed), /writes are not allowed/);
});

test("ReadPermalinkSchema requires url", () => {
    assert.throws(() => ReadPermalinkSchema.parse({}));
    assert.equal(ReadPermalinkSchema.parse({ url: "x" }).url, "x");
});

test("GetRepliesSchema defaults limit to 50", () => {
    const parsed = GetRepliesSchema.parse({ channel_id: "c", thread_ts: "t" });
    assert.equal(parsed.limit, 50);
});

test("GetRepliesSchema requires channel_id and thread_ts", () => {
    assert.throws(() => GetRepliesSchema.parse({}));
});

test("GetHistorySchema defaults limit to 20", () => {
    const parsed = GetHistorySchema.parse({ channel_id: "c" });
    assert.equal(parsed.limit, 20);
});

test("ReplyToThreadSchema requires all fields", () => {
    assert.throws(() => ReplyToThreadSchema.parse({}));
    const parsed = ReplyToThreadSchema.parse({ channel_id: "c", thread_ts: "t", text: "x" });
    assert.equal(parsed.text, "x");
});

test("AddReactionSchema requires all fields", () => {
    assert.throws(() => AddReactionSchema.parse({}));
});

test("RemoveReactionSchema requires all fields", () => {
    assert.throws(() => RemoveReactionSchema.parse({}));
    const parsed = RemoveReactionSchema.parse({ channel_id: "c", timestamp: "t", reaction: "x" });
    assert.equal(parsed.reaction, "x");
});

test("EditMessageSchema requires all fields", () => {
    assert.throws(() => EditMessageSchema.parse({}));
    const parsed = EditMessageSchema.parse({ channel_id: "c", timestamp: "t", text: "x" });
    assert.equal(parsed.text, "x");
});
