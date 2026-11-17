// Predefined bots: a bot file's instructions, skills, model, and thinking level, read and checked before a session is
// made; its skills named from the skills hub and read there, with nothing written into the session's folder; the bot
// recorded in the session's entry, and the sessions tool's filter by it; and a session started without one, as before.
import {
    type App,
    cleanUp,
    context,
    lastText,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";

const dataDir = join(root, "bots-data");
/** The skills hub bots name skills in: the data folder's `skills-hub/`, as `hub.ts` resolves it. */
const hub = join(dataDir, "skills-hub");
/** Each session's own folder, holding nothing another test's skills could be taken for. */
const folderOf = (name: string) => join(root, `bots-${name}`);

const SKILL = [
    "---",
    "name: polish",
    "description: Polish the prose of a file.",
    "---",
    "",
    "Rewrite the prose, and keep every fact.",
    "",
].join("\n");

/** PiP starts a bot's session when its person says so, and lists a bot's sessions. */
const route: FauxResponseStep = (request) => {
    const { role, text: written } = lastText(request as never);
    const text = written.replace(/^\[from: [^\]]+\] /, "");
    const started = /^startbot (\S+) (\S+)$/.exec(text);
    const listed = /^listbot (\S+)$/.exec(text);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`done: ${text}`)]);
    }

    if (started !== null) {
        return fauxAssistantMessage(
            [
                fauxToolCall("bot_start", {
                    bot: started[1]!,
                    folder: started[2]!,
                    title: "bot tool",
                    message: "look at it",
                    report: false,
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    return listed === null
        ? fauxAssistantMessage([fauxText(`echo: ${text}`)])
        : fauxAssistantMessage([fauxToolCall("sessions", { bot: listed[1]! })], {
              stopReason: "toolUse",
          });
};

const model = scriptedModel(route);
let app: App;

/** A bot file, as its person writes it in the data folder's `bots/`. */
function bot(name: string, value: unknown): void {
    writeFileSync(join(dataDir, "bots", `${name}.json`), JSON.stringify(value));
}

/** A skill in the hub, as a real one is: a folder with a `SKILL.md`. */
function hubSkill(name: string, text = SKILL): void {
    const folder = join(hub, "skills", name);

    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "SKILL.md"), text);
}

/** The owner's PiP, on the scripted model. */
async function pip(): Promise<ConversationId> {
    const id = await app.pip.ensure(owner(app));

    await app.commands.configure(id, owner(app), {
        model: { provider: "faux", modelId: "faux-1" },
        thinkingLevel: "off",
    });

    return id;
}

/** The texts of a conversation's user messages and Pi's answers, oldest first. */
async function said(id: ConversationId): Promise<string[]> {
    const entries = await app.transcripts.allEntries(id, true);

    return entries.flatMap((entry) =>
        entry.kind === "user"
            ? [`> ${entry.text}`]
            : entry.kind === "assistant"
              ? entry.blocks.flatMap((block) => (block.type === "text" ? [block.text] : []))
              : [],
    );
}

before(async () => {
    mkdirSync(join(dataDir, "bots"), { recursive: true });
    hubSkill("polish");

    for (const name of ["good", "taken", "plain", "tool"]) {
        mkdirSync(folderOf(name), { recursive: true });
    }

    app = await openApp(model, dataDir);
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a bot gives a session its instructions, model, thinking level, and hub skills", async () => {
    const id = await pip();
    const folder = folderOf("good");
    const instructions = "Always answer in French. Keep every fact.";

    bot("reviewer", { instructions, skills: ["polish"], model: "faux/faux-1", thinking: "high" });

    const made = await app.pip.startBot(id, { bot: "reviewer", folder });
    const state = await app.agentState(made.id);

    assert.deepEqual(made.hub, ["polish"]);
    assert.deepEqual(made.missing, []);
    assert.equal(made.folder, folder);
    assert.equal(state?.model?.modelId, "faux-1");
    // faux-1 has no thinking levels, so the bot's high is lowered to the one it has.
    assert.equal(state?.thinkingLevel, "off");
    assert.equal(app.sessionMeta(made.id)?.bot, "reviewer");

    // What is stored is the bot's own words: the block about its skills is the prompt's, on every request.
    assert.equal(state?.instructions, instructions);
    assert.equal((state?.instructions ?? "").includes("Bot skills"), false, "no block stored");

    // Nothing is copied into the session's folder: the skill stays in the hub.
    assert.equal(existsSync(join(folder, ".pi-pocket", "skills", "polish")), false);

    // The same bot again, in the same folder: the hub has it once, and both sessions name it.
    const again = await app.pip.startBot(id, { bot: "reviewer", folder });

    assert.deepEqual(again.hub, ["polish"]);
    assert.deepEqual(again.missing, []);
});

test("a bot that names a skill the hub does not have makes no session", async () => {
    const id = await pip();
    const before = app.sessions().length;

    bot("gappy", { skills: ["polish", "absent"], model: "faux/faux-1" });

    await assert.rejects(
        app.pip.startBot(id, { bot: "gappy", folder: folderOf("plain") }),
        /needs the skill “absent”, and the skills hub has none of that name: .*skills-hub\/skills\/absent has no SKILL\.md\. The skills hub .* has: “polish”/,
    );
    assert.equal(app.sessions().length, before, "no session made");
    await assert.rejects(
        app.pip.startBot(id, { bot: "nobody", folder: folderOf("plain") }),
        /There is no bot “nobody”\. The bots there are: .*“reviewer”/,
    );
    await assert.rejects(
        app.pip.startBot(id, { bot: "../escape", folder: folderOf("plain") }),
        /must be one name in the bots folder, not a path: “\.\.\/escape”\. The bots there are:/,
    );
});

test("a project's own copy of a skill is left as it is, and the session is told it wins", async () => {
    const id = await pip();
    const folder = folderOf("taken");
    const mine = join(folder, ".pi-pocket", "skills", "polish", "SKILL.md");

    bot("taken", { skills: ["polish"], model: "faux/faux-1" });
    mkdirSync(join(folder, ".pi-pocket", "skills", "polish"), { recursive: true });
    writeFileSync(mine, "Mine, and not the hub's.\n");

    const made = await app.pip.startBot(id, { bot: "taken", folder });

    assert.deepEqual(made.hub, ["polish"]);
    assert.equal(readFileSync(mine, "utf8"), "Mine, and not the hub's.\n");
    // Nothing of the prompt's block reaches the stored instructions.
    assert.equal((await app.agentState(made.id))?.instructions, undefined);
});

test("a bot in a worktree names its hub skills, and the worktree gets no copy", async () => {
    const id = await pip();
    const repo = folderOf("repo");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });

    mkdirSync(repo, { recursive: true });
    git("init", "-q");
    writeFileSync(join(repo, "README.md"), "A repository.\n");
    git("add", "README.md");
    git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "first");

    bot("worktree", { skills: ["polish"], model: "faux/faux-1" });

    const made = await app.pip.startBot(id, { bot: "worktree", folder: repo, worktree: true });
    const state = await app.agentState(made.id);

    assert.ok(app.sessionMeta(made.id)?.worktree !== undefined, "with its worktree");
    assert.deepEqual(made.hub, ["polish"]);
    assert.equal(state?.instructions, undefined);
    assert.equal(existsSync(join(app.cwdOf(made.id), ".pi-pocket", "skills", "polish")), false);
});

test("a bot's instructions and its hub skills are as limited as a person's", async () => {
    const id = await pip();
    const before = app.sessions().length;

    bot("long", { instructions: "x".repeat(8001), skills: [], model: "faux/faux-1" });

    await assert.rejects(
        app.pip.startBot(id, { bot: "long", folder: folderOf("plain") }),
        /Instructions are limited to 8000 characters/,
    );

    assert.equal(app.sessions().length, before, "no session made");
});

test("a bot without a model makes no session", async () => {
    const id = await pip();
    const before = app.sessions().length;

    bot("modelless", { instructions: "Be brief.", skills: [] });

    await assert.rejects(
        app.pip.startBot(id, { bot: "modelless", folder: folderOf("plain") }),
        /must name a model, as provider\/modelId/,
    );
    assert.equal(app.sessions().length, before, "no session made");
});

test("a bot with a thinking level that is not one makes no session", async () => {
    const id = await pip();
    const before = app.sessions().length;

    bot("loud", { skills: [], model: "faux/faux-1", thinking: "loud" });

    await assert.rejects(
        app.pip.startBot(id, { bot: "loud", folder: folderOf("plain") }),
        /The thinking level of bot “loud” must be one of off, .*: “loud” is not\./,
    );
    assert.equal(app.sessions().length, before, "no session made");
});

test("a session started without a bot is as it was, and no bot made it", async () => {
    const id = await pip();
    const folder = folderOf("plain");
    const made = await app.pip.start(id, { folder });
    const listed = app.pip.sessions(id).sessions.find((each) => each.id === Number(made));

    assert.equal((await app.agentState(made))?.instructions, undefined);
    assert.equal(app.sessionMeta(made)?.bot, undefined);
    assert.equal(listed?.bot, undefined);
    assert.equal(existsSync(join(folder, ".pi-pocket", "skills", "polish")), false);
});

test("the sessions tool lists only the sessions a bot made when it says which", async () => {
    const id = await pip();

    bot("filtered", { skills: [], model: "faux/faux-1", thinking: "off" });

    const made = await app.pip.startBot(id, { bot: "filtered", folder: folderOf("plain") });
    const plain = await app.pip.start(id, { folder: folderOf("plain") });
    const found = app.pip.sessions(id, { bot: "filtered" }).sessions;

    assert.deepEqual(
        found.map((each) => each.id),
        [Number(made.id)],
    );
    assert.ok(app.pip.sessions(id).sessions.some((each) => each.id === Number(plain)));

    await say(app, id, "listbot filtered");

    const lines = (await said(id)).join("\n");

    assert.ok(lines.includes(`#${String(made.id)} “New session”`), "the bot's session is listed");
    assert.ok(!lines.includes(`#${String(plain)} `), "the session no bot made is not");
});

test("PiP starts a bot's session with bot_start, and says where it works and what it got", async () => {
    const id = await pip();
    const folder = folderOf("tool");
    const started = app.sessions().length;

    bot("starting", {
        instructions: "Answer with the review only.",
        skills: ["polish"],
        model: "faux/faux-1",
        thinking: "off",
    });

    await say(app, id, `startbot starting ${folder}`);

    assert.equal(app.sessions().length, started + 1, "a session made");
    assert.ok(
        (await said(id))
            .join("\n")
            .includes(`Bot “starting”: folder ${folder}. Skills from the hub: polish.`),
    );
    const made = app.sessions().find((session) => session.title === "bot tool");

    assert.equal(made?.bot, "starting");
    assert.equal(
        (await app.agentState(made!.id as unknown as ConversationId))?.instructions,
        "Answer with the review only.",
    );

    // session_start takes no bot: only bot_start does.
    const fields = async (name: string) => {
        const found = (await (await app.conversation(id)).agent(context)).tools.find(
            (each) => each.name === name,
        );

        return found?.parameters as unknown as {
            properties: Record<string, unknown>;
            required?: string[];
        };
    };

    assert.equal((await fields("session_start")).properties.bot, undefined);
    assert.equal((await fields("bot_start")).properties.bot !== undefined, true);
    assert.deepEqual((await fields("bot_start")).required, ["bot"]);
    assert.equal((await fields("bot_start")).properties.model, undefined);
});
