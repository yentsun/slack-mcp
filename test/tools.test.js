import { test } from "node:test";
import assert from "node:assert/strict";
import { createExecuteToolCall, createSlackClient } from "../index.js";

function deps(overrides = {}) {
    const d = {
        allowedWriteChannels: [],
        slackApi: async () => ({ ok: true, messages: [] }),
        formatMessages: async (messages) =>
            messages.length ? [{ type: "text", text: messages[0].text || "" }] : [{ type: "text", text: "No messages found." }],
    };
    Object.assign(d, overrides);
    return d;
}

function text(result) {
    return result.content[0].text;
}

test("slack_read_permalink parses url and fetches replies", async () => {
    let captured;
    const exec = createExecuteToolCall(
        deps({
            slackApi: async (method, params) => {
                captured = { method, params };
                return {
                    messages: [
                        {
                            ts: "1784549814.834729",
                            user: "U1",
                            text: "hello",
                        },
                    ],
                };
            },
        })
    );
    const result = await exec("slack_read_permalink", {
        url: "https://example.slack.com/archives/C0123456789/p1234567890123456",
    });
    assert.equal(captured.method, "conversations.replies");
    assert.equal(captured.params.channel, "C0123456789");
    assert.equal(captured.params.ts, "1234567890.123456");
    assert.match(text(result), /hello/);
});

test("slack_get_replies passes channel and ts", async () => {
    let captured;
    const exec = createExecuteToolCall(
        deps({
            slackApi: async (method, params) => {
                captured = { method, params };
                return { messages: [] };
            },
        })
    );
    const result = await exec("slack_get_replies", {
        channel_id: "C1",
        thread_ts: "123.456",
        limit: 30,
    });
    assert.equal(captured.method, "conversations.replies");
    assert.equal(captured.params.channel, "C1");
    assert.equal(captured.params.ts, "123.456");
    assert.equal(captured.params.limit, "30");
    assert.match(text(result), /No messages found/);
});

test("formatMessages includes the contents of text attachments", async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });
    globalThis.fetch = async (url, options) => {
        assert.match(options.headers.authorization, /^Bearer xoxc-test$/);
        if (String(url).startsWith("https://slack.com/api/files.info")) {
            assert.equal(new URL(url).searchParams.get("file"), "F1");
            return Response.json({
                ok: true,
                file: {
                    url_private_download: "https://files.slack.com/files-pri/T1-F1/answers.md",
                },
            });
        }
        assert.equal(url, "https://files.slack.com/files-pri/T1-F1/answers.md");
        return new Response("# Answers\n\nThe attachment contents.", {
            status: 200,
            headers: { "content-type": "text/plain" },
        });
    };
    const { formatMessages } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    const content = await formatMessages([
        {
            ts: "123.456",
            user: "U1",
            text: "answers for both platforms",
            files: [
                {
                    id: "F1",
                    name: "mobile-agent-questionnaire-answers.md",
                    mimetype: "text/plain",
                },
            ],
        },
    ]);

    assert.deepEqual(content[1], {
        type: "text",
        text: "Text file: mobile-agent-questionnaire-answers.md\n\n# Answers\n\nThe attachment contents.",
    });
});

test("formatMessages stops downloading text attachments that exceed the size limit", async (t) => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });
    globalThis.fetch = async () => ({
        ok: true,
        headers: new Headers(),
        body: {
            getReader: () => ({
                read: async () => ({ done: false, value: { byteLength: 10 * 1024 * 1024 + 1 } }),
                cancel: async () => {
                    cancelled = true;
                },
            }),
        },
    });
    const { formatMessages } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    const content = await formatMessages([
        {
            ts: "123.456",
            user: "U1",
            files: [{ name: "large.txt", mimetype: "text/plain", url_private_download: "https://files.slack.com/large.txt" }],
        },
    ]);

    assert.equal(cancelled, true);
    assert.match(content[1].text, /Text file unavailable: text file exceeds 10 MB limit/);
});

test("slack_get_history calls conversations.history", async () => {
    let captured;
    const exec = createExecuteToolCall(
        deps({
            slackApi: async (method, params) => {
                captured = { method, params };
                return { messages: [] };
            },
        })
    );
    await exec("slack_get_history", { channel_id: "C1" });
    assert.equal(captured.method, "conversations.history");
    assert.equal(captured.params.channel, "C1");
    assert.equal(captured.params.limit, "20");
});

test("slack_reply_to_thread posts when channel allowed", async () => {
    let captured;
    const exec = createExecuteToolCall(
        deps({
            allowedWriteChannels: ["C1"],
            slackApi: async (method, params, httpMethod) => {
                captured = { method, params, httpMethod };
                return { ok: true, ts: "111.222" };
            },
        })
    );
    const result = await exec("slack_reply_to_thread", {
        channel_id: "C1",
        thread_ts: "123.456",
        text: "thanks",
    });
    assert.equal(captured.method, "chat.postMessage");
    assert.equal(captured.httpMethod, "POST");
    assert.equal(captured.params.channel, "C1");
    assert.equal(captured.params.text, "thanks");
    assert.match(text(result), /posted reply at 111\.222/);
});

test("slack_reply_to_thread rejects disallowed channel", async () => {
    const exec = createExecuteToolCall(deps({ allowedWriteChannels: ["C1"] }));
    await assert.rejects(
        () =>
            exec("slack_reply_to_thread", {
                channel_id: "C2",
                thread_ts: "123.456",
                text: "x",
            }),
        /writes are not allowed/
    );
});

test("slack_add_reaction adds reaction on allowed channel", async () => {
    let captured;
    const exec = createExecuteToolCall(
        deps({
            allowedWriteChannels: ["C1"],
            slackApi: async (method, params, httpMethod) => {
                captured = { method, params, httpMethod };
                return { ok: true };
            },
        })
    );
    const result = await exec("slack_add_reaction", {
        channel_id: "C1",
        timestamp: "123.456",
        reaction: "thumbsup",
    });
    assert.equal(captured.method, "reactions.add");
    assert.equal(captured.httpMethod, "POST");
    assert.equal(captured.params.name, "thumbsup");
    assert.match(text(result), /added reaction/);
});

test("slack_add_reaction rejects disallowed channel", async () => {
    const exec = createExecuteToolCall(deps({ allowedWriteChannels: [] }));
    await assert.rejects(
        () =>
            exec("slack_add_reaction", {
                channel_id: "C1",
                timestamp: "123.456",
                reaction: "x",
            }),
        /writes are not allowed/
    );
});

test("unknown tool throws", async () => {
    const exec = createExecuteToolCall(deps());
    await assert.rejects(() => exec("nope", {}), /Unknown tool: nope/);
});
