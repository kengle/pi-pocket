// The skills hub's two read-only tools: a list of the git repository of skills, one skill's SKILL.md by name, and the
// hubPath setting that moves the hub somewhere else. Nothing here runs a skill, and only the hub's own index is written.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Extension } from "@earendil-works/pi-durable";
import createSkillsHub from "../src/server/extensions/skills-hub.ts";

after(() => {
    cleanUp();
});

/** One skill of the hub: its frontmatter, and the steps under it. */
const skill = (name: string, description: string, tags: string[] = []): string =>
    [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        `tags: [${tags.join(", ")}]`,
        "---",
        "",
        `The steps of ${name}.`,
        "",
    ].join("\n");

/** A hub of the skills given, as its own git repository, so the tools have a commit to name. */
function hub(skills: Record<string, string>): string {
    const folder = mkdtempSync(join(root, "hub-"));

    for (const [name, text] of Object.entries(skills)) {
        mkdirSync(join(folder, "skills", name), { recursive: true });
        writeFileSync(join(folder, "skills", name, "SKILL.md"), text);
    }

    const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, stdio: "ignore" });

    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "first");

    return folder;
}

/** The module as the server loads it, with the owner's `hubPath` pointing at `folder`. */
function loaded(folder: string): Extension {
    const web = {
        settings: () => undefined,
        setting: (name: string) => (name === "hubPath" ? folder : undefined),
    };

    return createSkillsHub({} as never, web as never) as Extension;
}

/** What a tool of the module answers with, as the model reads it. */
async function answer(folder: string, tool: string, args: object): Promise<string> {
    const found = loaded(folder).tools?.find((each) => each.name === tool);
    const result = await found?.execute(args as never, {} as never, {} as never);
    const output = (result as { output?: { type: string; text?: string }[] }).output ?? [];

    return output.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])).join("\n");
}

test("skills_list names the skills of the hub, with its folder and commit", async () => {
    const folder = hub({
        "oss-deploy": skill("oss-deploy", "Publish files to Alibaba Cloud OSS.", ["deploy"]),
        "video-download": skill("video-download", "Download a video with yt-dlp.", ["media"]),
    });
    const text = await answer(folder, "skills_list", {});

    assert.match(text, /^hub @ [0-9a-f]{7} · 2 skills of /);
    assert.match(text, /- oss-deploy · tags: deploy\n {2}.*\/oss-deploy\n {2}Publish files/);
    assert.match(text, /- video-download · tags: media/);
    // Only the hub's own index is written: the skills are read as they are.
    assert.ok(readFileSync(join(folder, "hub.json"), "utf8").includes("oss-deploy"));
});

test("skills_list keeps a word, a tag, and a limit to what it finds", async () => {
    const folder = hub({
        "oss-deploy": skill("oss-deploy", "Publish files to Alibaba Cloud OSS.", ["deploy"]),
        "video-download": skill("video-download", "Download a video with yt-dlp.", ["media"]),
        "ffmpeg-skill": skill("ffmpeg-skill", "Edit a video and its audio.", ["media"]),
    });

    assert.deepEqual(
        (await answer(folder, "skills_list", { query: "video" })).match(/- [a-z-]+/g),
        ["- ffmpeg-skill", "- video-download"],
    );
    assert.deepEqual((await answer(folder, "skills_list", { tag: "deploy" })).match(/- [a-z-]+/g), [
        "- oss-deploy",
    ]);
    assert.match(await answer(folder, "skills_list", { limit: 1 }), /· 1 skill of /);
    assert.match(
        await answer(folder, "skills_list", { query: "nothing" }),
        /no skill of .* matches/,
    );
});

test("skills_get gives a skill's whole SKILL.md, its folder, its commit, and its start line", async () => {
    const folder = hub({
        "oss-deploy": skill("oss-deploy", "Publish files to Alibaba Cloud OSS."),
    });

    mkdirSync(join(folder, "skills", "oss-deploy", "scripts"), { recursive: true });
    writeFileSync(join(folder, "skills", "oss-deploy", "scripts", "deploy.sh"), "echo hi\n");
    execFileSync("git", ["add", "-A"], { cwd: folder, stdio: "ignore" });
    execFileSync(
        "git",
        ["-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-qm", "script"],
        {
            cwd: folder,
            stdio: "ignore",
        },
    );

    const text = await answer(folder, "skills_get", { name: "oss-deploy" });

    assert.match(text, /^# oss-deploy\nFolder: /);
    assert.match(text, /\nCommit: [0-9a-f]{7}\n/);
    assert.match(text, /\nStart: cd .* && bash scripts\/deploy\.sh\n/);
    assert.match(text, /description: Publish files to Alibaba Cloud OSS\./);
    assert.match(text, /The steps of oss-deploy\./);
});

test("skills_get names the skill it does not have", async () => {
    const folder = hub({ "oss-deploy": skill("oss-deploy", "Publish files.") });

    await assert.rejects(
        answer(folder, "skills_get", { name: "absent" }),
        /has no skill called "absent"/,
    );
});

test("hubPath moves the hub: another folder, another list", async () => {
    const first = hub({ "oss-deploy": skill("oss-deploy", "Publish files.") });
    const second = hub({ "video-download": skill("video-download", "Download a video.") });

    assert.match(await answer(first, "skills_list", {}), /oss-deploy/);
    assert.ok(!(await answer(first, "skills_list", {})).includes("video-download"));
    assert.match(await answer(second, "skills_list", {}), /video-download/);

    // The module is the same one the server loads: it names its tool and its setting, and asks the owner for no other.
    const extension = loaded(first);
    const fields: string[] = [];

    createSkillsHub(
        {} as never,
        {
            settings: (list: { name: string }[]) => fields.push(...list.map((each) => each.name)),
            setting: () => undefined,
        } as never,
    );

    assert.equal(extension.name, "skills-hub");
    assert.deepEqual(
        extension.tools?.map((tool) => tool.name),
        ["skills_list", "skills_get"],
    );
    assert.deepEqual(fields, ["hubPath"]);
});
