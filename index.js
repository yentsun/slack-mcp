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


const DEFAULT_SECRETS_DIR = path.join(os.homedir(), ".config", "opencode", "secrets");
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "yt-slack-mcp", "config.json");

const maxImageBytes = 10 * 1024 * 1024;
const maxPdfBytes = 20 * 1024 * 1024;
const maxPdfPages = 50;
const maxPdfTextCharacters = 100_000;
const maxTextFileBytes = 10 * 1024 * 1024;
const maxTextFileCharacters = 100_000;

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

    const getSlackFileData = async (file) => {
        if (file.url_private_download || file.url_private || !file.id) {
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

    return { slackApi, formatMessages };
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
];

// ── Execute factory (exported for tests) ─────────────────────────────────────

function createExecuteToolCall({ slackApi, formatMessages, allowedWriteChannels }) {
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

    const { slackApi, formatMessages } = createSlackClient({ xoxcToken, xoxdToken, userAgent: config.userAgent });

    const server = new Server(
        { name: "yt-slack-mcp", version: "0.1.0" },
        {
            capabilities: { tools: {} },
            instructions:
                "MCP server for Slack. Read with slack_read_permalink, slack_get_replies, slack_get_history; write with slack_reply_to_thread, slack_add_reaction (restricted to allowed channels).",
        }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    const executeToolCall = createExecuteToolCall({
        slackApi,
        formatMessages,
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
};
