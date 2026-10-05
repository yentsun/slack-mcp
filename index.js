#!/usr/bin/env node

// Slack MCP server. Mirrors yt-gmail-mcp / yt-zoho-mcp's structure: pure
// helpers and the execute-tool factory are exported for unit tests; main()
// only runs when the file is executed directly.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";


const DEFAULT_SECRETS_DIR = path.join(os.homedir(), ".config", "yt-slack-mcp", "secrets");
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "yt-slack-mcp", "config.json");

const maxImageBytes = 10 * 1024 * 1024;
const maxPdfBytes = 20 * 1024 * 1024;
const maxPdfPages = 50;
const maxPdfTextCharacters = 100_000;
const maxTextFileBytes = 10 * 1024 * 1024;
const maxTextFileCharacters = 100_000;
const maxUploadBytes = 10 * 1024 * 1024;

function expandHome(filePath) {
    if (!filePath) {
        return filePath;
    }
    if (filePath === "~") {
        return os.homedir();
    }
    if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
        return path.join(os.homedir(), filePath.slice(2));
    }
    return filePath;
}

function parseChannelList(value) {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    return value
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
}

function loadConfig(env = process.env) {
    const configPath = env.SLACK_MCP_CONFIG || DEFAULT_CONFIG_PATH;
    let fileConfig = {};
    if (fs.existsSync(configPath)) {
        try {
            fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
        } catch (e) {
            throw new Error(`invalid Slack MCP config ${configPath}: ${e.message}`);
        }
    }

    const secretsDir =
        env.SLACK_MCP_SECRETS_DIR || expandHome(fileConfig.secretsDir) || DEFAULT_SECRETS_DIR;
    const xoxcPath =
        env.SLACK_MCP_XOXC_PATH || expandHome(fileConfig.xoxcPath) || path.join(secretsDir, "slack-xoxc.txt");
    const xoxdPath =
        env.SLACK_MCP_XOXD_PATH || expandHome(fileConfig.xoxdPath) || path.join(secretsDir, "slack-xoxd.txt");
    const allowedWriteChannels =
        parseChannelList(env.SLACK_MCP_ALLOWED_WRITE_CHANNELS) ?? fileConfig.allowedWriteChannels ?? [];
    const userAgent = env.SLACK_MCP_USER_AGENT || fileConfig.userAgent || "Mozilla/5.0";

    return { configPath, secretsDir, xoxcPath, xoxdPath, allowedWriteChannels, userAgent };
}

function readSecret(filePath, label) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`missing ${label} (looked at ${filePath})`);
    }
    return fs.readFileSync(filePath, "utf8").trim().replace(/^['"]|['"]$/g, "");
}

function createSlackClient({ xoxcToken, xoxdToken, userAgent = "Mozilla/5.0" }) {
    const slackHeaders = () => ({
        authorization: `Bearer ${xoxcToken}`,
        cookie: `d=${xoxdToken}`,
        "user-agent": userAgent,
        "content-type": "application/x-www-form-urlencoded",
    });

    const slackApi = async (method, params, httpMethod = "GET") => {
        const url = new URL(`https://slack.com/api/${method}`);
        const options = { method: httpMethod, headers: slackHeaders() };
        if (httpMethod === "GET") {
            for (const [key, value] of Object.entries(params)) {
                if (value !== undefined && value !== null) {
                    url.searchParams.set(key, value);
                }
            }
        } else {
            options.body = new URLSearchParams(params).toString();
        }
        const response = await fetch(url, options);
        const data = await response.json();
        if (!data.ok) {
            throw new Error(`slack ${method} failed: ${data.error || response.statusText}`);
        }
        return data;
    };

    const getSlackFileData = async (file, { refresh = false } = {}) => {
        if (!refresh && (file.url_private_download || file.url_private || !file.id)) {
            return file;
        }
        const response = await slackApi("files.info", { file: file.id });
        return response.file || file;
    };

    const downloadSlackImage = async (file) => {
        const fileData = await getSlackFileData(file);
        const imageUrl = fileData.url_private_download || fileData.url_private;
        if (!imageUrl) {
            throw new Error("Slack did not provide a private image URL");
        }
        const response = await fetch(imageUrl, { headers: slackHeaders() });
        if (!response.ok) {
            throw new Error(`Slack image download failed: ${response.status}`);
        }
        const imageData = await response.arrayBuffer();
        if (imageData.byteLength > maxImageBytes) {
            throw new Error(`image exceeds ${maxImageBytes / 1024 / 1024} MB limit`);
        }
        const mimeType = response.headers.get("content-type") || fileData.mimetype;
        if (!mimeType?.startsWith("image/")) {
            throw new Error(`Slack returned ${mimeType || "an unknown content type"}`);
        }
        return { type: "image", data: Buffer.from(imageData).toString("base64"), mimeType: mimeType.split(";", 1)[0] };
    };

    const extractPdfText = async (pdfData) => {
        const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const document = await pdfjs.getDocument({ data: new Uint8Array(pdfData), useWorkerFetch: false, isEvalSupported: false }).promise;
        const pageCount = Math.min(document.numPages, maxPdfPages);
        const pages = [];
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
            const page = await document.getPage(pageNumber);
            const textContent = await page.getTextContent();
            const lines = [];
            let line = "";
            for (const item of textContent.items) {
                if (!("str" in item)) continue;
                line += `${item.str}${item.hasEOL ? "" : " "}`;
                if (item.hasEOL) {
                    lines.push(line.trim());
                    line = "";
                }
            }
            if (line.trim()) lines.push(line.trim());
            pages.push(`Page ${pageNumber}\n${lines.join("\n")}`);
        }
        let text = pages.join("\n\n").trim();
        if (document.numPages > maxPdfPages) {
            text += `\n\n[PDF text truncated after ${maxPdfPages} pages]`;
        }
        if (text.length > maxPdfTextCharacters) {
            text = `${text.slice(0, maxPdfTextCharacters)}\n\n[PDF text truncated at ${maxPdfTextCharacters} characters]`;
        }
        return text || "[PDF contains no extractable text]";
    };

    const downloadSlackPdf = async (file) => {
        const fileData = await getSlackFileData(file);
        const pdfUrl = fileData.url_private_download || fileData.url_private;
        if (!pdfUrl) {
            throw new Error("Slack did not provide a private PDF URL");
        }
        const response = await fetch(pdfUrl, { headers: slackHeaders() });
        if (!response.ok) {
            throw new Error(`Slack PDF download failed: ${response.status}`);
        }
        const pdfData = await response.arrayBuffer();
        if (pdfData.byteLength > maxPdfBytes) {
            throw new Error(`PDF exceeds ${maxPdfBytes / 1024 / 1024} MB limit`);
        }
        const mimeType = response.headers.get("content-type") || fileData.mimetype;
        if (mimeType !== "application/pdf" && !(fileData.name || "").toLowerCase().endsWith(".pdf")) {
            throw new Error(`Slack returned ${mimeType || "an unknown content type"}`);
        }
        return extractPdfText(pdfData);
    };

    const downloadSlackText = async (file) => {
        const fileData = await getSlackFileData(file);
        const textUrl = fileData.url_private_download || fileData.url_private;
        if (!textUrl) {
            throw new Error("Slack did not provide a private text file URL");
        }
        const response = await fetch(textUrl, { headers: slackHeaders() });
        if (!response.ok) {
            throw new Error(`Slack text file download failed: ${response.status}`);
        }
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > maxTextFileBytes) {
            await response.body?.cancel();
            throw new Error(`text file exceeds ${maxTextFileBytes / 1024 / 1024} MB limit`);
        }
        const reader = response.body?.getReader();
        if (!reader) {
            throw new Error("Slack returned an empty text file response");
        }
        const chunks = [];
        let byteLength = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            byteLength += value.byteLength;
            if (byteLength > maxTextFileBytes) {
                await reader.cancel();
                throw new Error(`text file exceeds ${maxTextFileBytes / 1024 / 1024} MB limit`);
            }
            chunks.push(Buffer.from(value));
        }
        let text = Buffer.concat(chunks, byteLength).toString("utf8");
        if (text.length > maxTextFileCharacters) {
            text = `${text.slice(0, maxTextFileCharacters)}\n\n[Text file truncated at ${maxTextFileCharacters} characters]`;
        }
        return text;
    };

    const uploadSlackFiles = async ({ filePaths, channelId, threadTs, initialComment }) => {
        const localFiles = filePaths.map((filePath) => {
            const fileStats = fs.statSync(filePath);
            if (!fileStats.isFile()) {
                throw new Error(`not a file: ${filePath}`);
            }
            if (fileStats.size > maxUploadBytes) {
                throw new Error(`file exceeds ${maxUploadBytes / 1024 / 1024} MB limit: ${filePath}`);
            }
            const data = fs.readFileSync(filePath);
            if (data.length > maxUploadBytes) {
                throw new Error(`file exceeds ${maxUploadBytes / 1024 / 1024} MB limit: ${filePath}`);
            }
            return { name: path.basename(filePath), data };
        });

        const uploadedFiles = [];
        for (const file of localFiles) {
            const upload = await slackApi("files.getUploadURLExternal", {
                filename: file.name,
                length: String(file.data.length),
            }, "POST");
            if (!upload.upload_url || !upload.file_id) {
                throw new Error("Slack did not provide an upload URL or file ID");
            }
            const response = await fetch(upload.upload_url, {
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: file.data,
            });
            if (!response.ok) {
                throw new Error(`Slack file upload failed: ${response.status}`);
            }
            uploadedFiles.push({ id: upload.file_id, title: file.name });
        }

        const completeParams = {
            files: JSON.stringify(uploadedFiles),
            channel_id: channelId,
        };
        if (threadTs) completeParams.thread_ts = threadTs;
        if (initialComment) completeParams.initial_comment = initialComment;
        const completed = await slackApi("files.completeUploadExternal", completeParams, "POST");
        if (!completed.files?.length) {
            throw new Error("Slack did not return uploaded file details");
        }
        return Promise.all(completed.files.map(async (file) => {
            const fileData = await getSlackFileData(file, { refresh: true });
            const shares = Object.values(fileData.shares || {});
            const share = shares.flatMap((shareType) => shareType[channelId] || []).at(0);
            if (!share?.ts) {
                return fileData;
            }
            try {
                const permalink = await slackApi("chat.getPermalink", {
                    channel: channelId,
                    message_ts: share.ts,
                });
                return { ...fileData, message_permalink: permalink.permalink };
            } catch {
                return fileData;
            }
        }));
    };

    const formatMessages = async (messages) => {
        if (!messages.length) {
            return [{ type: "text", text: "No messages found." }];
        }
        const content = [];
        for (const message of messages) {
            const author = message.user || message.username || message.bot_id || "unknown";
            const lines = [`[${message.ts}] ${author}: ${message.text || ""}`];
            if (message.files?.length) {
                for (const file of message.files) {
                    lines.push(`file: ${file.title || file.name || file.id || "untitled"} (${file.mimetype || "unknown type"})`);
                }
            }
            if (message.attachments?.length) {
                for (const attachment of message.attachments) {
                    if (attachment.title) lines.push(`attachment: ${attachment.title}`);
                    if (attachment.text) lines.push(`attachment text: ${attachment.text}`);
                }
            }
            content.push({ type: "text", text: lines.join("\n") });
            for (const file of message.files || []) {
                if (file.mimetype?.startsWith("image/")) {
                    try {
                        content.push(await downloadSlackImage(file));
                    } catch (error) {
                        content.push({ type: "text", text: `image unavailable: ${error.message}` });
                    }
                    continue;
                }
                if (file.mimetype === "application/pdf" || file.name?.toLowerCase().endsWith(".pdf")) {
                    try {
                        const title = file.title || file.name || file.id || "untitled";
                        content.push({ type: "text", text: `PDF text: ${title}\n\n${await downloadSlackPdf(file)}` });
                    } catch (error) {
                        content.push({ type: "text", text: `PDF unavailable: ${error.message}` });
                    }
                    continue;
                }
                if (file.mimetype?.startsWith("text/")) {
                    try {
                        const title = file.title || file.name || file.id || "untitled";
                        content.push({ type: "text", text: `Text file: ${title}\n\n${await downloadSlackText(file)}` });
                    } catch (error) {
                        content.push({ type: "text", text: `Text file unavailable: ${error.message}` });
                    }
                }
            }
        }
        return content;
    };

    return { slackApi, formatMessages, uploadSlackFiles };
}

function parsePermalink(url) {
    const match = url.match(/\/archives\/([CDG][A-Z0-9]+)\/p(\d{10})(\d{6})/);
    if (!match) {
        throw new Error("invalid Slack permalink");
    }
    return { channelId: match[1], timestamp: `${match[2]}.${match[3]}` };
}

function requireString(value, name) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`missing ${name}`);
    }
    return value.trim();
}

function assertAllowedWriteChannel(channelId, allowed) {
    if (!allowed.has(channelId)) {
        throw new Error(`writes are not allowed for channel ${channelId}`);
    }
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const ReadPermalinkSchema = z.object({
    url: z.string().describe("Slack permalink, e.g. https://<workspace>.slack.com/archives/C.../p..."),
});

const GetRepliesSchema = z.object({
    channel_id: z.string(),
    thread_ts: z.string(),
    limit: z.number().int().min(1).max(200).optional().default(50),
});

const GetHistorySchema = z.object({
    channel_id: z.string(),
    limit: z.number().int().min(1).max(200).optional().default(20),
});

const ReplyToThreadSchema = z.object({
    channel_id: z.string(),
    thread_ts: z.string(),
    text: z.string(),
});

const AddReactionSchema = z.object({
    channel_id: z.string(),
    timestamp: z.string(),
    reaction: z.string().describe("Emoji name without colons."),
});

const RemoveReactionSchema = z.object({
    channel_id: z.string(),
    timestamp: z.string(),
    reaction: z.string().describe("Emoji name without colons."),
});

const UploadFilesSchema = z.object({
    channel_id: z.string(),
    file_paths: z.array(z.string().min(1)).min(1).max(10),
    thread_ts: z.string().optional(),
    initial_comment: z.string().optional(),
});

const EditMessageSchema = z.object({
    channel_id: z.string(),
    timestamp: z.string().describe("Timestamp of the message or thread reply to edit."),
    text: z.string(),
});

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
    {
        name: "slack_read_permalink",
        description: "Read a Slack message or thread from a permalink, including inline text files, extracted PDFs, and images.",
        inputSchema: zodToJsonSchema(ReadPermalinkSchema),
    },
    {
        name: "slack_get_replies",
        description: "Read replies for a Slack thread by channel id and thread timestamp.",
        inputSchema: zodToJsonSchema(GetRepliesSchema),
    },
    {
        name: "slack_get_history",
        description: "Read recent Slack channel history.",
        inputSchema: zodToJsonSchema(GetHistorySchema),
    },
    {
        name: "slack_reply_to_thread",
        description: "Reply to a Slack thread. Restricted to allowed channels.",
        inputSchema: zodToJsonSchema(ReplyToThreadSchema),
    },
    {
        name: "slack_add_reaction",
        description: "Add a reaction to a Slack message. Restricted to allowed channels.",
        inputSchema: zodToJsonSchema(AddReactionSchema),
    },
    {
        name: "slack_remove_reaction",
        description: "Remove a reaction added by this account from a Slack message. Restricted to allowed channels.",
        inputSchema: zodToJsonSchema(RemoveReactionSchema),
    },
    {
        name: "slack_upload_files",
        description: "Upload one or more local files to a channel or thread. Restricted to allowed channels.",
        inputSchema: zodToJsonSchema(UploadFilesSchema),
    },
    {
        name: "slack_edit_message",
        description: "Edit an authored Slack message or thread reply by channel id and timestamp. Replaces the message text; any existing Block Kit blocks are removed by Slack. Restricted to allowed channels.",
        inputSchema: zodToJsonSchema(EditMessageSchema),
    },
];

// ── Execute factory (exported for tests) ─────────────────────────────────────

function createExecuteToolCall({ slackApi, formatMessages, uploadSlackFiles, allowedWriteChannels }) {
    const allowed = new Set(allowedWriteChannels);
    return async function executeToolCall(name, args) {
        switch (name) {
            case "slack_read_permalink": {
                const a = ReadPermalinkSchema.parse(args);
                const { channelId, timestamp } = parsePermalink(a.url);
                const messages = await slackApi("conversations.replies", {
                    channel: channelId,
                    ts: timestamp,
                    limit: "50",
                });
                return { content: await formatMessages(messages.messages || []) };
            }

            case "slack_get_replies": {
                const a = GetRepliesSchema.parse(args);
                const messages = await slackApi("conversations.replies", {
                    channel: a.channel_id,
                    ts: a.thread_ts,
                    limit: String(a.limit),
                });
                return { content: await formatMessages(messages.messages || []) };
            }

            case "slack_get_history": {
                const a = GetHistorySchema.parse(args);
                const messages = await slackApi("conversations.history", {
                    channel: a.channel_id,
                    limit: String(a.limit),
                });
                return { content: await formatMessages(messages.messages || []) };
            }

            case "slack_reply_to_thread": {
                const a = ReplyToThreadSchema.parse(args);
                const channelId = requireString(a.channel_id, "channel_id");
                assertAllowedWriteChannel(channelId, allowed);
                const response = await slackApi("chat.postMessage", {
                    channel: channelId,
                    thread_ts: requireString(a.thread_ts, "thread_ts"),
                    text: requireString(a.text, "text"),
                }, "POST");
                return { content: [{ type: "text", text: `posted reply at ${response.ts}` }] };
            }

            case "slack_add_reaction": {
                const a = AddReactionSchema.parse(args);
                const channelId = requireString(a.channel_id, "channel_id");
                assertAllowedWriteChannel(channelId, allowed);
                await slackApi("reactions.add", {
                    channel: channelId,
                    timestamp: requireString(a.timestamp, "timestamp"),
                    name: requireString(a.reaction, "reaction"),
                }, "POST");
                return { content: [{ type: "text", text: "added reaction" }] };
            }

            case "slack_remove_reaction": {
                const a = RemoveReactionSchema.parse(args);
                const channelId = requireString(a.channel_id, "channel_id");
                assertAllowedWriteChannel(channelId, allowed);
                await slackApi("reactions.remove", {
                    channel: channelId,
                    timestamp: requireString(a.timestamp, "timestamp"),
                    name: requireString(a.reaction, "reaction"),
                }, "POST");
                return { content: [{ type: "text", text: "removed reaction" }] };
            }

            case "slack_upload_files": {
                const a = UploadFilesSchema.parse(args);
                const channelId = requireString(a.channel_id, "channel_id");
                assertAllowedWriteChannel(channelId, allowed);
                const files = await uploadSlackFiles({
                    filePaths: a.file_paths,
                    channelId,
                    threadTs: a.thread_ts && requireString(a.thread_ts, "thread_ts"),
                    initialComment: a.initial_comment,
                });
                return {
                    content: files.map((file) => ({
                        type: "text",
                        text: `uploaded file: ${file.title || file.name || file.id}\nfile permalink: ${file.permalink || "unavailable"}\nmessage permalink: ${file.message_permalink || "unavailable"}`,
                    })),
                };
            }

            case "slack_edit_message": {
                const a = EditMessageSchema.parse(args);
                const channelId = requireString(a.channel_id, "channel_id");
                assertAllowedWriteChannel(channelId, allowed);
                const timestamp = requireString(a.timestamp, "timestamp");
                const text = requireString(a.text, "text");
                let updated;
                try {
                    updated = await slackApi("chat.update", {
                        channel: channelId,
                        ts: timestamp,
                        text,
                    }, "POST");
                } catch (error) {
                    const reason = String(error?.message ?? error).replace(/^slack chat\.update failed: /, "");
                    throw new Error(
                        `could not edit message ${timestamp} in ${channelId}: ${reason}. ` +
                            "Slack only allows editing messages authored by this account, within its edit window, and in a channel the caller can write to."
                    );
                }
                const messageTs = updated.ts || timestamp;
                let permalink;
                try {
                    const result = await slackApi("chat.getPermalink", {
                        channel: channelId,
                        message_ts: messageTs,
                    });
                    permalink = result.permalink;
                } catch {
                    permalink = undefined;
                }
                const lines = [`edited message ${messageTs}`];
                if (permalink) lines.push(`permalink: ${permalink}`);
                return { content: [{ type: "text", text: lines.join("\n") }] };
            }

            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    let config;
    try {
        config = loadConfig();
    } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    }

    let xoxcToken, xoxdToken;
    try {
        xoxcToken = readSecret(config.xoxcPath, "slack-xoxc.txt");
        xoxdToken = readSecret(config.xoxdPath, "slack-xoxd.txt");
    } catch (e) {
        console.error(`Error: ${e.message}`);
        process.exit(1);
    }

    const { slackApi, formatMessages, uploadSlackFiles } = createSlackClient({ xoxcToken, xoxdToken, userAgent: config.userAgent });

    const server = new Server(
        { name: "yt-slack-mcp", version: "0.1.0" },
        {
            capabilities: { tools: {} },
            instructions:
                "MCP server for Slack. Read with slack_read_permalink, slack_get_replies, slack_get_history; write with slack_reply_to_thread, slack_add_reaction, slack_remove_reaction, slack_upload_files, slack_edit_message (restricted to allowed channels).",
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    const executeToolCall = createExecuteToolCall({
        slackApi,
        formatMessages,
        uploadSlackFiles,
        allowedWriteChannels: config.allowedWriteChannels,
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args } = req.params;
        try {
            return await executeToolCall(name, args);
        } catch (e) {
            return {
                content: [{ type: "text", text: `Error: ${e.message}` }],
                isError: true,
            };
        }
    });

    const transport = new StdioServerTransport();
    await server.connect(transport);
}

const isMain =
    process.argv[1] &&
    fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    main().catch((e) => {
        console.error("Fatal:", e);
        process.exit(1);
    });
}

export {
    TOOLS,
    parsePermalink,
    requireString,
    assertAllowedWriteChannel,
    createExecuteToolCall,
    createSlackClient,
    loadConfig,
    expandHome,
    parseChannelList,
    ReadPermalinkSchema,
    GetRepliesSchema,
    GetHistorySchema,
    ReplyToThreadSchema,
    AddReactionSchema,
    RemoveReactionSchema,
    UploadFilesSchema,
    EditMessageSchema,
};
