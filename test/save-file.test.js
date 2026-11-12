import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    createExecuteToolCall,
    createSlackClient,
    parseFileReference,
    resolveDestinationPath,
    safeFilename,
} from "../index.js";

const SVG = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">\n' +
        '  <rect width="10" height="10" fill="#0af"/>\n' +
        "</svg>\n"
);

function tempDir(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "slack-mcp-save-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function restoreFetch(t) {
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });
}

test("saves an SVG attachment from a message permalink byte for byte", async (t) => {
    const directory = tempDir(t);
    restoreFetch(t);
    const downloads = [];
    globalThis.fetch = async (url, options = {}) => {
        assert.equal(options.headers.authorization, "Bearer xoxc-test");
        assert.equal(options.headers.cookie, "d=xoxd-test");
        const stringUrl = String(url);
        if (stringUrl.startsWith("https://slack.com/api/conversations.replies")) {
            const params = new URL(stringUrl).searchParams;
            assert.equal(params.get("channel"), "C0123456789");
            assert.equal(params.get("ts"), "1234567890.123456");
            return Response.json({
                ok: true,
                messages: [
                    {
                        ts: "1234567890.123456",
                        files: [{ id: "F1", name: "logo.svg", mimetype: "image/svg+xml" }],
                    },
                ],
            });
        }
        if (stringUrl.startsWith("https://slack.com/api/files.info")) {
            return Response.json({
                ok: true,
                file: {
                    id: "F1",
                    name: "logo.svg",
                    mimetype: "image/svg+xml",
                    url_private_download: "https://files.slack.com/files-pri/T1-F1/logo.svg",
                },
            });
        }
        downloads.push(stringUrl);
        return new Response(SVG, {
            status: 200,
            headers: { "content-type": "image/svg+xml; charset=utf-8" },
        });
    };
    const { saveSlackFile } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    const saved = await saveSlackFile({
        reference: "https://example.slack.com/archives/C0123456789/p1234567890123456",
        destinationPath: directory,
    });

    const expectedPath = path.join(directory, "logo.svg");
    assert.equal(saved.path, expectedPath);
    assert.equal(saved.filename, "logo.svg");
    assert.equal(saved.mimeType, "image/svg+xml");
    assert.deepEqual(Object.keys(saved).sort(), ["filename", "mimeType", "path"]);
    assert.deepEqual(fs.readFileSync(expectedPath), SVG);
    assert.deepEqual(downloads, ["https://files.slack.com/files-pri/T1-F1/logo.svg"]);
});

test("finds a file on a reply beyond the first thread page", async (t) => {
    const directory = tempDir(t);
    restoreFetch(t);
    const pageParams = [];
    globalThis.fetch = async (url) => {
        const parsed = new URL(String(url));
        if (parsed.pathname.endsWith("/conversations.replies")) {
            pageParams.push({
                ts: parsed.searchParams.get("ts"),
                limit: parsed.searchParams.get("limit"),
                cursor: parsed.searchParams.get("cursor"),
            });
            if (!parsed.searchParams.get("cursor")) {
                return Response.json({
                    ok: true,
                    messages: [{ ts: "1234567890.123456" }],
                    response_metadata: { next_cursor: "page-2" },
                });
            }
            return Response.json({
                ok: true,
                messages: [
                    {
                        ts: "1234567890.999999",
                        files: [{ id: "F1", name: "logo.svg", mimetype: "image/svg+xml" }],
                    },
                ],
                response_metadata: { next_cursor: "" },
            });
        }
        if (parsed.pathname.endsWith("/files.info")) {
            return Response.json({
                ok: true,
                file: {
                    id: "F1",
                    name: "logo.svg",
                    mimetype: "image/svg+xml",
                    url_private_download: "https://files.slack.com/files-pri/T1-F1/logo.svg",
                },
            });
        }
        return new Response(SVG, { status: 200, headers: { "content-type": "image/svg+xml" } });
    };
    const { saveSlackFile } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    const saved = await saveSlackFile({
        reference:
            "https://example.slack.com/archives/C0123456789/p1234567890999999?thread_ts=1234567890.123456&cid=C0123456789",
        destinationPath: directory,
    });

    assert.deepEqual(pageParams, [
        { ts: "1234567890.123456", limit: "200", cursor: null },
        { ts: "1234567890.123456", limit: "200", cursor: "page-2" },
    ]);
    assert.equal(saved.filename, "logo.svg");
    assert.deepEqual(fs.readFileSync(path.join(directory, "logo.svg")), SVG);
});

test("saves a file ID to an explicit destination path", async (t) => {
    const directory = tempDir(t);
    restoreFetch(t);
    globalThis.fetch = async (url) => {
        const stringUrl = String(url);
        if (stringUrl.startsWith("https://slack.com/api/files.info")) {
            assert.equal(new URL(stringUrl).searchParams.get("file"), "F0123ABCD");
            return Response.json({
                ok: true,
                file: {
                    id: "F0123ABCD",
                    name: "icon.svg",
                    mimetype: "image/svg+xml",
                    url_private: "https://files.slack.com/files-pri/T1-F0123ABCD/icon.svg",
                },
            });
        }
        return new Response(SVG, { status: 200, headers: { "content-type": "image/svg+xml" } });
    };
    const { saveSlackFile } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    const destination = path.join(directory, "renamed.svg");
    const saved = await saveSlackFile({ reference: "F0123ABCD", destinationPath: destination });

    assert.equal(saved.path, destination);
    assert.equal(saved.filename, "renamed.svg");
    assert.equal(saved.mimeType, "image/svg+xml");
    assert.deepEqual(fs.readFileSync(destination), SVG);
});

test("surfaces a download failure without writing a file or exposing tokens", async (t) => {
    const directory = tempDir(t);
    restoreFetch(t);
    globalThis.fetch = async (url) => {
        if (String(url).startsWith("https://slack.com/api/files.info")) {
            return Response.json({
                ok: true,
                file: {
                    id: "F1",
                    name: "logo.svg",
                    mimetype: "image/svg+xml",
                    url_private_download: "https://files.slack.com/files-pri/T1-F1/logo.svg",
                },
            });
        }
        return new Response("not found", { status: 404 });
    };
    const { saveSlackFile } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    await assert.rejects(
        () => saveSlackFile({ reference: "F1", destinationPath: directory }),
        (error) => {
            assert.match(error.message, /Slack file download failed: 404/);
            assert.doesNotMatch(error.message, /xoxc-test|xoxd-test/);
            return true;
        }
    );
    assert.deepEqual(fs.readdirSync(directory), []);
});

test("rejects invalid destination paths before downloading", async (t) => {
    const directory = tempDir(t);
    const missingDirectory = path.join(directory, "missing");
    assert.equal(fs.existsSync(missingDirectory), false);

    assert.throws(() => resolveDestinationPath("", "logo.svg"), /missing destination_path/);
    assert.throws(
        () => resolveDestinationPath(path.join(missingDirectory, "logo.svg"), "logo.svg"),
        /destination directory does not exist/
    );
    assert.throws(
        () => resolveDestinationPath(`${missingDirectory}${path.sep}`, "logo.svg"),
        /destination directory does not exist/
    );
    assert.equal(resolveDestinationPath(directory, "logo.svg").path, path.join(directory, "logo.svg"));

    restoreFetch(t);
    let downloadAttempted = false;
    globalThis.fetch = async (url) => {
        if (String(url).startsWith("https://slack.com/api/files.info")) {
            return Response.json({
                ok: true,
                file: {
                    id: "F1",
                    name: "logo.svg",
                    mimetype: "image/svg+xml",
                    url_private_download: "https://files.slack.com/files-pri/T1-F1/logo.svg",
                },
            });
        }
        downloadAttempted = true;
        return new Response(SVG, { status: 200 });
    };
    const { saveSlackFile } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    await assert.rejects(
        () => saveSlackFile({ reference: "F1", destinationPath: path.join(missingDirectory, "logo.svg") }),
        /destination directory does not exist/
    );
    assert.equal(downloadAttempted, false);
});

test("sanitizes attachment names the local filesystem cannot write", () => {
    assert.equal(safeFilename("Q3: plan.pdf", "win32"), "Q3_ plan.pdf");
    assert.equal(safeFilename("report?.svg", "win32"), "report_.svg");
    assert.equal(safeFilename("trailing. ", "win32"), "trailing");
    assert.equal(safeFilename("CON.txt", "win32"), "_CON.txt");
    assert.equal(safeFilename("Q3: plan.pdf", "linux"), "Q3: plan.pdf");
    assert.equal(safeFilename("a/b.svg", "linux"), "a_b.svg");
    assert.equal(safeFilename("..", "win32"), "slack-file");
});

test("refuses to overwrite a file in a directory destination", async (t) => {
    const directory = tempDir(t);
    const existing = path.join(directory, "logo.svg");
    fs.writeFileSync(existing, "local copy");
    restoreFetch(t);
    let downloads = 0;
    globalThis.fetch = async (url) => {
        if (String(url).startsWith("https://slack.com/api/files.info")) {
            return Response.json({
                ok: true,
                file: {
                    id: "F1",
                    name: "logo.svg",
                    mimetype: "image/svg+xml",
                    url_private_download: "https://files.slack.com/files-pri/T1-F1/logo.svg",
                },
            });
        }
        downloads += 1;
        return new Response(SVG, { status: 200, headers: { "content-type": "image/svg+xml" } });
    };
    const { saveSlackFile } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    await assert.rejects(
        () => saveSlackFile({ reference: "F1", destinationPath: directory }),
        /destination file already exists/
    );
    assert.equal(downloads, 0);
    assert.equal(fs.readFileSync(existing, "utf8"), "local copy");

    const saved = await saveSlackFile({ reference: "F1", destinationPath: existing });
    assert.equal(saved.filename, "logo.svg");
    assert.deepEqual(fs.readFileSync(existing), SVG);
});

test("refuses to overwrite a file that appears during the download", async (t) => {
    const directory = tempDir(t);
    const raced = path.join(directory, "logo.svg");
    restoreFetch(t);
    let downloadStarted = false;
    globalThis.fetch = async (url) => {
        if (String(url).startsWith("https://slack.com/api/files.info")) {
            return Response.json({
                ok: true,
                file: {
                    id: "F1",
                    name: "logo.svg",
                    mimetype: "image/svg+xml",
                    url_private_download: "https://files.slack.com/files-pri/T1-F1/logo.svg",
                },
            });
        }
        if (!downloadStarted) {
            downloadStarted = true;
            fs.writeFileSync(raced, "raced copy");
        }
        return new Response(SVG, { status: 200, headers: { "content-type": "image/svg+xml" } });
    };
    const { saveSlackFile } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    await assert.rejects(
        () => saveSlackFile({ reference: "F1", destinationPath: directory }),
        /destination file already exists/
    );
    assert.equal(fs.readFileSync(raced, "utf8"), "raced copy");
    assert.deepEqual(fs.readdirSync(directory), ["logo.svg"]);
});

test("writes through a symlinked destination to its target", async (t) => {
    const directory = tempDir(t);
    const target = path.join(directory, "target.svg");
    const link = path.join(directory, "current.svg");
    fs.writeFileSync(target, "original");
    try {
        fs.symlinkSync(target, link);
    } catch (error) {
        t.skip(`symlinks unavailable: ${error.code}`);
        return;
    }
    restoreFetch(t);
    globalThis.fetch = async (url) => {
        if (String(url).startsWith("https://slack.com/api/files.info")) {
            return Response.json({
                ok: true,
                file: {
                    id: "F1",
                    name: "logo.svg",
                    mimetype: "image/svg+xml",
                    url_private_download: "https://files.slack.com/files-pri/T1-F1/logo.svg",
                },
            });
        }
        return new Response(SVG, { status: 200, headers: { "content-type": "image/svg+xml" } });
    };
    const { saveSlackFile } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    const saved = await saveSlackFile({ reference: "F1", destinationPath: link });

    assert.equal(saved.path, link);
    assert.equal(saved.filename, "current.svg");
    assert.deepEqual(fs.readFileSync(target), SVG);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test("creates the target of a dangling symlink and keeps the link", async (t) => {
    const directory = tempDir(t);
    const realDirectory = path.join(directory, "real");
    fs.mkdirSync(realDirectory);
    const target = path.join(realDirectory, "new.svg");
    const link = path.join(directory, "current.svg");
    try {
        fs.symlinkSync(path.join("real", "new.svg"), link);
    } catch (error) {
        t.skip(`symlinks unavailable: ${error.code}`);
        return;
    }
    restoreFetch(t);
    globalThis.fetch = async (url) => {
        if (String(url).startsWith("https://slack.com/api/files.info")) {
            return Response.json({
                ok: true,
                file: {
                    id: "F1",
                    name: "logo.svg",
                    mimetype: "image/svg+xml",
                    url_private_download: "https://files.slack.com/files-pri/T1-F1/logo.svg",
                },
            });
        }
        return new Response(SVG, { status: 200, headers: { "content-type": "image/svg+xml" } });
    };
    const { saveSlackFile } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    const saved = await saveSlackFile({ reference: "F1", destinationPath: link });

    assert.equal(saved.path, link);
    assert.equal(saved.filename, "current.svg");
    assert.deepEqual(fs.readFileSync(target), SVG);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test("leaves no partial file when the download fails mid-stream", async (t) => {
    const directory = tempDir(t);
    restoreFetch(t);
    globalThis.fetch = async (url) => {
        if (String(url).startsWith("https://slack.com/api/files.info")) {
            return Response.json({
                ok: true,
                file: {
                    id: "F1",
                    name: "logo.svg",
                    mimetype: "image/svg+xml",
                    url_private_download: "https://files.slack.com/files-pri/T1-F1/logo.svg",
                },
            });
        }
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("<svg"));
                controller.error(new Error("connection reset"));
            },
        });
        return new Response(body, { status: 200, headers: { "content-type": "image/svg+xml" } });
    };
    const { saveSlackFile } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    await assert.rejects(
        () => saveSlackFile({ reference: "F1", destinationPath: directory }),
        /could not save Slack file/
    );
    assert.deepEqual(fs.readdirSync(directory), []);
});

test("reports filesystem access errors instead of blaming a missing directory", (t) => {
    const directory = tempDir(t);
    const originalStatSync = fs.statSync;
    fs.statSync = () => {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
    };
    t.after(() => {
        fs.statSync = originalStatSync;
    });

    assert.throws(
        () => resolveDestinationPath(path.join(directory, "logo.svg"), "logo.svg"),
        /could not access .*logo\.svg: EACCES/
    );
});

test("asks for a file ID when a message has more than one attachment", async (t) => {
    restoreFetch(t);
    globalThis.fetch = async () =>
        Response.json({
            ok: true,
            messages: [
                {
                    ts: "1234567890.123456",
                    files: [
                        { id: "F1", name: "one.svg" },
                        { id: "F2", name: "two.png" },
                    ],
                },
            ],
        });
    const { saveSlackFile } = createSlackClient({ xoxcToken: "xoxc-test", xoxdToken: "xoxd-test" });

    await assert.rejects(
        () =>
            saveSlackFile({
                reference: "https://example.slack.com/archives/C0123456789/p1234567890123456",
                destinationPath: os.tmpdir(),
            }),
        /has 2 files; pass a file ID or file permalink to choose one: F1 \(one\.svg\), F2 \(two\.png\)/
    );
});

test("parseFileReference accepts file IDs, file permalinks, and message permalinks", () => {
    assert.deepEqual(parseFileReference("F0123ABCD"), { fileId: "F0123ABCD" });
    assert.deepEqual(parseFileReference("f0123abcd"), { fileId: "F0123ABCD" });
    assert.deepEqual(parseFileReference("https://example.slack.com/files/U1/F0123ABCD/logo.svg"), {
        fileId: "F0123ABCD",
    });
    assert.deepEqual(parseFileReference("https://example.slack.com/archives/C0123456789/p1234567890123456"), {
        message: { channelId: "C0123456789", timestamp: "1234567890.123456" },
    });
    assert.throws(() => parseFileReference("https://example.com/logo.svg"), /invalid Slack file reference/);
});

test("slack_save_file reports the saved path, filename, and MIME type", async () => {
    let captured;
    const exec = createExecuteToolCall({
        allowedWriteChannels: [],
        slackApi: async () => ({ ok: true }),
        formatMessages: async () => [],
        uploadSlackFiles: async () => [],
        saveSlackFile: async (args) => {
            captured = args;
            return { path: "C:/tmp/logo.svg", filename: "logo.svg", mimeType: "image/svg+xml" };
        },
    });

    const result = await exec("slack_save_file", { file: "F1", destination_path: "C:/tmp" });

    assert.deepEqual(captured, { reference: "F1", destinationPath: "C:/tmp" });
    assert.equal(
        result.content[0].text,
        "saved file: C:/tmp/logo.svg\nfilename: logo.svg\nmime type: image/svg+xml"
    );
});
