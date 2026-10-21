import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, expandHome, parseChannelList } from "../index.js";

test("expandHome expands ~ and leaves absolute paths alone", () => {
    assert.equal(expandHome("~"), os.homedir());
    assert.equal(expandHome(`~${path.sep}foo`), path.join(os.homedir(), "foo"));
    assert.equal(expandHome("C:/x/y"), "C:/x/y");
    assert.equal(expandHome(undefined), undefined);
});

test("parseChannelList parses arrays and comma lists, ignoring blanks", () => {
    assert.deepEqual(parseChannelList("C1, C2 ,"), ["C1", "C2"]);
    assert.deepEqual(parseChannelList(["C1", " C2 ", ""]), ["C1", "C2"]);
    assert.equal(parseChannelList(undefined), null);
    assert.equal(parseChannelList(""), null);
    assert.throws(() => parseChannelList(1), /channel IDs/);
});

test("loadConfig uses defaults when the config file is absent", () => {
    const config = loadConfig("C:/nonexistent/config.json");
    assert.equal(config.secretsDir, path.join(os.homedir(), ".config", "yt-slack-mcp", "secrets"));
    assert.equal(config.xoxcPath, path.join(config.secretsDir, "slack-xoxc.txt"));
    assert.equal(config.xoxdPath, path.join(config.secretsDir, "slack-xoxd.txt"));
    assert.deepEqual(config.allowedWriteChannels, []);
    assert.equal(config.userAgent, "Mozilla/5.0");
});

test("loadConfig reads a config file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-mcp-config-"));
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(
        configPath,
        JSON.stringify({
            secretsDir: "~/custom-secrets",
            allowedWriteChannels: ["C1", "C2"],
            userAgent: "test-agent",
        })
    );
    const config = loadConfig(configPath);
    assert.equal(config.secretsDir, path.join(os.homedir(), "custom-secrets"));
    assert.equal(config.xoxcPath, path.join(os.homedir(), "custom-secrets", "slack-xoxc.txt"));
    assert.deepEqual(config.allowedWriteChannels, ["C1", "C2"]);
    assert.equal(config.userAgent, "test-agent");
});

test("loadConfig accepts a legacy env object with SLACK_MCP_CONFIG", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-mcp-config-"));
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ allowedWriteChannels: ["C1"] }));
    const config = loadConfig({ SLACK_MCP_CONFIG: configPath });
    assert.deepEqual(config.allowedWriteChannels, ["C1"]);
});

test("loadConfig normalizes a comma-separated allowedWriteChannels string", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-mcp-config-"));
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ allowedWriteChannels: "C1, C2 ," }));
    const config = loadConfig(configPath);
    assert.deepEqual(config.allowedWriteChannels, ["C1", "C2"]);
});

test("loadConfig rejects non-string channel IDs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-mcp-config-"));
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ allowedWriteChannels: ["C1", 2] }));
    assert.throws(() => loadConfig(configPath), /invalid Slack MCP config/);
});

test("loadConfig ignores environment variables", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-mcp-config-"));
    const configPath = path.join(dir, "config.json");
    const envConfigPath = path.join(dir, "env-config.json");
    fs.writeFileSync(configPath, JSON.stringify({ allowedWriteChannels: ["C1"] }));
    fs.writeFileSync(envConfigPath, JSON.stringify({ allowedWriteChannels: ["C9"] }));
    const previous = {
        SLACK_MCP_ALLOWED_WRITE_CHANNELS: process.env.SLACK_MCP_ALLOWED_WRITE_CHANNELS,
        SLACK_MCP_SECRETS_DIR: process.env.SLACK_MCP_SECRETS_DIR,
        SLACK_MCP_CONFIG: process.env.SLACK_MCP_CONFIG,
    };
    process.env.SLACK_MCP_ALLOWED_WRITE_CHANNELS = "C9";
    process.env.SLACK_MCP_SECRETS_DIR = path.join(dir, "env-secrets");
    process.env.SLACK_MCP_CONFIG = envConfigPath;
    try {
        const config = loadConfig(configPath);
        assert.deepEqual(config.allowedWriteChannels, ["C1"]);
        assert.equal(config.secretsDir, path.join(os.homedir(), ".config", "yt-slack-mcp", "secrets"));
        const defaultConfig = loadConfig();
        assert.equal(
            defaultConfig.configPath,
            path.join(os.homedir(), ".config", "yt-slack-mcp", "config.json")
        );
        assert.notEqual(defaultConfig.configPath, envConfigPath);
    } finally {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});

test("loadConfig throws on invalid config file JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-mcp-config-"));
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, "not json");
    assert.throws(() => loadConfig(configPath), /invalid Slack MCP config/);
});
