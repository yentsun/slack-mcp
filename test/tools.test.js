import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createExecuteToolCall, createSlackClient } from "../index.js";

function deps(overrides = {}) {
    const d = {
        allowedWriteChannels: [],
        slackApi: async () => ({ ok: true, messages: [] }),
        formatMessages: async (messages) =>
            messages.length ? [{ type: "text", text: messages[0].text || "" }] : [{ type: "text", text: "No messages found." }],
        uploadSlackFiles: async () => [],
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

test("uploadSlackFiles uploads local files and completes the Slack upload", async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slack-mcp-upload-"));
    const filePath = path.join(directory, "contract.md");
    fs.writeFileSync(filePath, "# Contract\n");
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
        fs.rmSync(directory, { recursive: true, force: true });
    });
    globalThis.fetch = async (url, options) => {
        if (url === "https://upload.slack.com/F1") {
            assert.equal(options.method, "POST");
            assert.deepEqual(options.body, Buffer.from("# Contract\n"));
            return new Response("", { status: 200 });
        }
        assert.match(options.headers.authorization || "", /^Bearer xoxc-test$/);
        if (String(url).startsWith("https://slack.com/api/files.getUploadURLExternal")) {
            const params = new URLSearchParams(options.body);
            assert.equal(params.get("filename"), "contract.md");
            assert.equal(params.get("length"), "11");
            return Response.json({ ok: true, upload_url: "https://upload.slack.com/F1", file_id: "F1" });
        }
        if (String(url).startsWith("https://slack.com/api/files.info")) {
            assert.equal(new URL(url).searchParams.get("file"), "F1");
            return Response.json({
                ok: true,
                file: {
                    id: "F1",
                    title: "contract.md",
                    permalink: "https://example.slack.com/files/U1/F1",
                    shares: { public: { C1: [{ ts: "1234567890.123456" }] } },
                },
            });
        }
        if (String(url).startsWith("https://slack.com/api/chat.getPermalink")) {
            const params = new URL(url).searchParams;
            assert.equal(params.get("channel"), "C1");
            assert.equal(params.get("message_ts"), "1234567890.123456");
            return Response.json({ ok: true, permalink: "https://example.slack.com/archives/C1/p1234567890123456" });
        }
        assert.match(String(url), /files\.completeUploadExternal/);
        const params = new URLSearchParams(options.body);
        assert.equal(params.get("channel_id"), "C1");
        assert.equal(params.get("thread_ts"), "123.456");
        assert.equal(params.get("initial_comment"), "Here is the contract.");
        assert.deepEqual(JSON.parse(params.get("files")), [{ id: "F1", title: "contract.md" }]);
        return Response.json({
            ok: true,
            files: [{ id: "F1", title: "contract.md", url_private: "https://files.slack.com/files-pri/T1-F1/contract.md" }],
        });
    };
    const { uploadSlackFiles } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    const files = await uploadSlackFiles({
        filePaths: [filePath],
        channelId: "C1",
        threadTs: "123.456",
        initialComment: "Here is the contract.",
    });

    assert.equal(files[0].message_permalink, "https://example.slack.com/archives/C1/p1234567890123456");
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

test("slack_remove_reaction removes reaction on allowed channel", async () => {
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
    const result = await exec("slack_remove_reaction", {
        channel_id: "C1",
        timestamp: "123.456",
        reaction: "thumbsup",
    });
    assert.equal(captured.method, "reactions.remove");
    assert.equal(captured.httpMethod, "POST");
    assert.equal(captured.params.name, "thumbsup");
    assert.match(text(result), /removed reaction/);
});

test("slack_remove_reaction rejects disallowed channel", async () => {
    const exec = createExecuteToolCall(deps({ allowedWriteChannels: [] }));
    await assert.rejects(
        () =>
            exec("slack_remove_reaction", {
                channel_id: "C1",
                timestamp: "123.456",
                reaction: "x",
            }),
        /writes are not allowed/
    );
});

test("slack_upload_files uploads to an allowed thread and returns permalinks", async () => {
    let captured;
    const exec = createExecuteToolCall(
        deps({
            allowedWriteChannels: ["C1"],
            uploadSlackFiles: async (args) => {
                captured = args;
                return [{
                    id: "F1",
                    title: "contract.md",
                    permalink: "https://example.slack.com/files/U1/F1",
                    message_permalink: "https://example.slack.com/archives/C1/p1234567890123456",
                }];
            },
        })
    );

    const result = await exec("slack_upload_files", {
        channel_id: "C1",
        file_paths: ["C:/tmp/contract.md"],
        thread_ts: "123.456",
        initial_comment: "Here is the contract.",
    });

    assert.deepEqual(captured, {
        channelId: "C1",
        filePaths: ["C:/tmp/contract.md"],
        threadTs: "123.456",
        initialComment: "Here is the contract.",
    });
    assert.match(text(result), /uploaded file: contract\.md/);
    assert.match(text(result), /file permalink: https:\/\/example\.slack\.com\/files\/U1\/F1/);
    assert.match(text(result), /https:\/\/example\.slack\.com\/archives\/C1\/p1234567890123456/);
});

test("slack_upload_files rejects disallowed channels", async () => {
    const exec = createExecuteToolCall(deps({ allowedWriteChannels: ["C1"] }));
    await assert.rejects(
        () => exec("slack_upload_files", { channel_id: "C2", file_paths: ["C:/tmp/contract.md"] }),
        /writes are not allowed/
    );
});

test("slack_edit_message updates an allowed message and returns the permalink", async () => {
    const calls = [];
    const exec = createExecuteToolCall(
        deps({
            allowedWriteChannels: ["C1"],
            slackApi: async (method, params, httpMethod) => {
                calls.push({ method, params, httpMethod });
                if (method === "chat.update") {
                    return { ok: true, ts: "123.456", text: "updated text" };
                }
                return { ok: true, permalink: "https://example.slack.com/archives/C1/p1234567890123456" };
            },
        })
    );

    const result = await exec("slack_edit_message", {
        channel_id: "C1",
        timestamp: "123.456",
        text: "updated text",
    });

    assert.deepEqual(calls[0], {
        method: "chat.update",
        params: { channel: "C1", ts: "123.456", text: "updated text" },
        httpMethod: "POST",
    });
    assert.equal(calls[1].method, "chat.getPermalink");
    assert.equal(
        text(result),
        "edited message 123.456\npermalink: https://example.slack.com/archives/C1/p1234567890123456"
    );
});

test("slack_edit_message edits a thread reply by its timestamp", async () => {
    let captured;
    const exec = createExecuteToolCall(
        deps({
            allowedWriteChannels: ["C1"],
            slackApi: async (method, params) => {
                if (method === "chat.update") {
                    captured = params;
                    return { ok: true, ts: params.ts };
                }
                return { ok: true };
            },
        })
    );

    await exec("slack_edit_message", {
        channel_id: "C1",
        timestamp: "1784549814.834729",
        text: "corrected deployment status",
    });

    assert.equal(captured.channel, "C1");
    assert.equal(captured.ts, "1784549814.834729");
    assert.equal(captured.text, "corrected deployment status");
});

test("slack_edit_message rejects disallowed channels", async () => {
    const exec = createExecuteToolCall(deps({ allowedWriteChannels: ["C1"] }));
    await assert.rejects(
        () => exec("slack_edit_message", { channel_id: "C2", timestamp: "123.456", text: "x" }),
        /writes are not allowed/
    );
});

test("slack_edit_message surfaces an actionable error when Slack rejects the edit", async () => {
    const exec = createExecuteToolCall(
        deps({
            allowedWriteChannels: ["C1"],
            slackApi: async (method) => {
                if (method === "chat.update") {
                    throw new Error("slack chat.update failed: cant_update_message");
                }
                return { ok: true };
            },
        })
    );
    await assert.rejects(
        () => exec("slack_edit_message", { channel_id: "C1", timestamp: "123.456", text: "x" }),
        /could not edit message 123\.456 in C1: cant_update_message\. Slack only allows editing messages authored by this account/
    );
});

test("slack_edit_message omits the permalink when chat.getPermalink fails", async () => {
    const exec = createExecuteToolCall(
        deps({
            allowedWriteChannels: ["C1"],
            slackApi: async (method, params) => {
                if (method === "chat.update") {
                    return { ok: true, ts: params.ts };
                }
                throw new Error("slack chat.getPermalink failed: message_not_found");
            },
        })
    );

    const result = await exec("slack_edit_message", {
        channel_id: "C1",
        timestamp: "123.456",
        text: "updated text",
    });

    assert.equal(text(result), "edited message 123.456");
});

test("unknown tool throws", async () => {
    const exec = createExecuteToolCall(deps());
    await assert.rejects(() => exec("nope", {}), /Unknown tool: nope/);
});
