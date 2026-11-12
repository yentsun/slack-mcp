import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, SERVER_INFO } from "../index.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = fs.readFileSync(path.join(root, "skills", "slack-mcp", "SKILL.md"), "utf8");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("skill frontmatter names the skill and states when to use it", () => {
    const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    assert.ok(frontmatter, "SKILL.md must start with YAML frontmatter");
    assert.match(frontmatter, /^name: slack-mcp$/m);
    const description = frontmatter.match(/^description: (.+)$/m)?.[1] ?? "";
    assert.match(description, /Use when/);
    assert.ok(description.length > 40);
});

test("skill maps every shipped tool", () => {
    const toolMap = skill.split("## Tool map")[1]?.split("## Recipes")[0];
    assert.ok(toolMap, "SKILL.md must contain a Tool map section");
    const mapped = new Set([...toolMap.matchAll(/`(slack_[a-z_]+)`/g)].map((match) => match[1]));
    const shipped = new Set(TOOLS.map((tool) => tool.name));
    assert.deepEqual([...mapped].sort(), [...shipped].sort());
});

test("skill install command and version match package.json", () => {
    assert.match(skill, new RegExp(`npx ${pkg.name}`));
    assert.match(skill, new RegExp(pkg.version.replace(/\./g, "\\.")));
});

test("write tools ask for the backend model ID and keep model optional", () => {
    const writeTools = TOOLS.filter((tool) => tool.inputSchema.properties?.model);
    assert.deepEqual(
        writeTools.map((tool) => tool.name).sort(),
        ["slack_edit_message", "slack_reply_to_thread", "slack_upload_files"]
    );
    for (const tool of writeTools) {
        const name = tool.name;
        const model = tool.inputSchema.properties.model;
        assert.equal(model.type, "string", `${name} model must stay a string`);
        assert.match(model.description, /backend model ID/i, `${name} must ask for the backend model ID`);
        assert.match(tool.description, /backend model ID/i, `${name} must repeat the rule in its description`);
        assert.match(model.description, /claude-sonnet-4-5/, `${name} must show an ID-shaped example`);
        assert.doesNotMatch(model.description, /gpt-5\.1/, `${name} must not show a display-name example`);
        assert.equal(
            (tool.inputSchema.required || []).includes("model"),
            false,
            `${name} must keep model optional`
        );
    }
    assert.match(skill, /backend model ID/);
    assert.match(readme, /backend model ID/);
});

test("server metadata version matches package.json", () => {
    assert.equal(SERVER_INFO.version, pkg.version);
});

test("README tool table maps every shipped tool", () => {
    const mapped = new Set([...readme.matchAll(/`(slack_[a-z_]+)`/g)].map((match) => match[1]));
    const shipped = new Set(TOOLS.map((tool) => tool.name));
    assert.deepEqual([...mapped].sort(), [...shipped].sort());
});

test("README links the skill", () => {
    assert.match(readme, /skills\/slack-mcp\/SKILL\.md/);
});

test("skill and README document file-based config only", () => {
    assert.doesNotMatch(skill, /SLACK_MCP_[A-Z_]+/);
    assert.doesNotMatch(readme, /SLACK_MCP_[A-Z_]+/);
});
