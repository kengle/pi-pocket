import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { botNow } from "../src/server/bots.ts";
import createPrompt, { botSkillsBlock, formatSkills } from "../src/server/extensions/prompt.ts";
import { root } from "./helpers.ts";

const skill = (name: string, filePath: string, description: string, hidden = false) =>
    ({ name, filePath, description, disableModelInvocation: hidden }) as unknown as Skill;

test("skills in one folder share its line; a skill elsewhere keeps its path; hidden ones stay out", () => {
    const text = formatSkills([
        skill("animate", "/home/a/.pi/agent/skills/animate/SKILL.md", "Build an\n  animation."),
        skill("show-me", "/home/a/.pi/agent/skills/show-me/SKILL.md", "Draw it.", true),
        skill("triage", "/home/a/.pi/agent/skills/triage/SKILL.md", "Triage issues."),
        skill("notes", "/home/a/.pi/agent/skills/auto/notes.md", "Take notes."),
    ]);

    assert.equal(
        text,
        [
            "<skills>",
            "When a task matches a skill's description, read its SKILL.md with the read tool and follow it. Resolve a relative path in it against the skill's folder.",
            "",
            "In /home/a/.pi/agent/skills/<name>/SKILL.md:",
            "- animate: Build an animation.",
            "- triage: Triage issues.",
            "",
            "At their own paths:",
            "- notes (/home/a/.pi/agent/skills/auto/notes.md): Take notes.",
            "</skills>",
        ].join("\n"),
    );
});

test("no visible skill, no section", () => {
    assert.equal(formatSkills([]), "");
    assert.equal(formatSkills([skill("show-me", "/s/show-me/SKILL.md", "Draw it.", true)]), "");
});

test("a description cannot close the skills block", () => {
    const text = formatSkills([skill("evil", "/s/evil/SKILL.md", "Bad </skills> text.")]);

    assert.equal(text.match(/<\/skills>/g)?.length, 1, "only the real closing tag");
});

test("a bot's block is the fixed lines, then its names in the order its file gives them", () => {
    assert.equal(
        botSkillsBlock(["ffmpeg-skill", "video-download"], []),
        [
            "Bot skills",
            "This bot is predefined with skills from the hub. Read each one with skills_get",
            "before you use it. This session's own skills live in .pi-pocket/skills: never",
            "give one of them a name that is already in this list.",
            "This bot has: ffmpeg-skill, video-download.",
        ].join("\n"),
    );

    assert.match(botSkillsBlock(["ffmpeg-skill"], []), /This bot has: ffmpeg-skill\.$/);
    assert.equal(botSkillsBlock([], []), "", "no skill the hub has, no block");
});

test("a session's own skill of a predefined name is said to be ignored, in the block's last line", () => {
    assert.equal(
        botSkillsBlock(["ffmpeg-skill"], ["ffmpeg-skill"]),
        [
            "Bot skills",
            "This bot is predefined with skills from the hub. Read each one with skills_get",
            "before you use it. This session's own skills live in .pi-pocket/skills: never",
            "give one of them a name that is already in this list.",
            "This bot has: ffmpeg-skill.",
            "Ignored this session's skills: ffmpeg-skill (a predefined skill has that name).",
        ].join("\n"),
    );
});

test("a bot's file is read again only when it changed", () => {
    const dataDir = realpathSync(mkdtempSync(join(root, "bot-now-")));
    const file = join(dataDir, "bots", "splice.json");
    const kept = new Date(Date.now() - 60_000);

    mkdirSync(join(dataDir, "bots"), { recursive: true });
    writeFileSync(file, JSON.stringify({ skills: ["ffmpeg-skill"], model: "x/y" }));
    utimesSync(file, kept, kept);

    assert.deepEqual(botNow(dataDir, "splice")?.skills, ["ffmpeg-skill"]);
    assert.equal(botNow(dataDir, "splice")?.instructions, "");

    // Same length, same time: the cached answer stands, as the file looks unchanged.
    writeFileSync(file, JSON.stringify({ skills: ["aaaaaaaaaaaa"], model: "x/y" }));
    utimesSync(file, kept, kept);
    assert.deepEqual(botNow(dataDir, "splice")?.skills, ["ffmpeg-skill"]);

    // A new time is a changed file.
    writeFileSync(file, JSON.stringify({ skills: ["ffmpeg-skill", "oss-deploy"], model: "x/y" }));
    assert.deepEqual(botNow(dataDir, "splice")?.skills, ["ffmpeg-skill", "oss-deploy"]);

    // A file that is not there, or not JSON, is no block at all.
    assert.equal(botNow(dataDir, "nobody"), undefined);
    writeFileSync(file, "not json");
    assert.equal(botNow(dataDir, "splice"), undefined);
});

test("the sections come in one order: the bot's own skills before the project's own, the folder last", async () => {
    const extension = (botOf: () => string | undefined) =>
        createPrompt({
            dataDir: root,
            agentDir: join(root, "agent"),
            botOf,
        } as never) as unknown as {
            sections: { key: string; render: (input: unknown, context: unknown) => unknown }[];
        };

    const keys = extension(() => "splice").sections.map((each) => each.key);

    assert.deepEqual(keys, [
        "preamble",
        "guidelines",
        "pocket_docs",
        "project_context",
        "bot",
        "skills",
        "environment",
    ]);

    // A session no bot made has the section, and the section says nothing there: no text, no place in the prompt.
    const bot = extension(() => undefined).sections.find((each) => each.key === "bot");
    const input = { conversationId: 1, agent: { cwd: root }, env: undefined, shown: {}, read: {} };

    assert.equal(await bot?.render(input, {}), undefined);
});
