import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../index.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = fs.readFileSync(path.join(root, "skills", "slack-mcp", "SKILL.md"), "utf8");
const listing = fs.readFileSync(path.join(root, "skills", "slack-mcp", "LISTING.md"), "utf8");
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
    for (const tool of TOOLS) {
        assert.match(toolMap, new RegExp(`\`${tool.name}\``), `${tool.name} is missing from the tool map`);
    }
});

test("skill install command and version match package.json", () => {
    assert.match(skill, new RegExp(`npx ${pkg.name}`));
    assert.match(skill, new RegExp(pkg.version.replace(/\./g, "\\.")));
});

test("README links the skill and the listing draft", () => {
    assert.match(readme, /skills\/slack-mcp\/SKILL\.md/);
    assert.match(readme, /skills\/slack-mcp\/LISTING\.md/);
    assert.ok(listing.includes("Trigger example"));
});
