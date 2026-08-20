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

test("parseChannelList parses comma lists and ignores blanks", () => {
    assert.deepEqual(parseChannelList("C1, C2 ,"), ["C1", "C2"]);
    assert.equal(parseChannelList(undefined), null);
    assert.equal(parseChannelList(""), null);
});

test("loadConfig uses defaults when no config and no env", () => {
    const config = loadConfig({ SLACK_MCP_CONFIG: "C:/nonexistent/config.json" });
    assert.equal(config.secretsDir, path.join(os.homedir(), ".config", "opencode", "secrets"));
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
    const config = loadConfig({ SLACK_MCP_CONFIG: configPath });
    assert.equal(config.secretsDir, path.join(os.homedir(), "custom-secrets"));
    assert.equal(config.xoxcPath, path.join(os.homedir(), "custom-secrets", "slack-xoxc.txt"));
    assert.deepEqual(config.allowedWriteChannels, ["C1", "C2"]);
    assert.equal(config.userAgent, "test-agent");
});

test("loadConfig lets env vars override the config file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-mcp-config-"));
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({ allowedWriteChannels: ["C1"] }));
    const config = loadConfig({
        SLACK_MCP_CONFIG: configPath,
        SLACK_MCP_ALLOWED_WRITE_CHANNELS: "C9",
        SLACK_MCP_SECRETS_DIR: "/tmp/env-secrets",
    });
    assert.deepEqual(config.allowedWriteChannels, ["C9"]);
    assert.equal(config.secretsDir, "/tmp/env-secrets");
});

test("loadConfig throws on invalid config file JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-mcp-config-"));
    const configPath = path.join(dir, "config.json");
    fs.writeFileSync(configPath, "not json");
    assert.throws(() => loadConfig({ SLACK_MCP_CONFIG: configPath }), /invalid Slack MCP config/);
});
