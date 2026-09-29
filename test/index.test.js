import { test } from "node:test";
import assert from "node:assert/strict";
import {
    parsePermalink,
    requireString,
    assertAllowedWriteChannel,
    ReadPermalinkSchema,
    GetRepliesSchema,
    GetHistorySchema,
    ReplyToThreadSchema,
    AddReactionSchema,
    EditMessageSchema,
    TOOLS,
} from "../index.js";

test("every tool declares explicit MCP behavior annotations", () => {
    const expected = {
        slack_read_permalink: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        slack_get_replies: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        slack_get_history: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        slack_reply_to_thread: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        slack_add_reaction: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        slack_upload_files: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        slack_edit_message: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    };

    assert.deepEqual(Object.fromEntries(TOOLS.map(({ name, annotations }) => [name, annotations])), expected);
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

test("EditMessageSchema requires all fields", () => {
    assert.throws(() => EditMessageSchema.parse({}));
    const parsed = EditMessageSchema.parse({ channel_id: "c", timestamp: "t", text: "x" });
    assert.equal(parsed.text, "x");
});
