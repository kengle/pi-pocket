// Predefined bots: a bot file's instructions, skills, model, and thinking level, read and checked before a session is
// made; its skills copied into the folder the session works in, never over a folder that is not the bot's; the bot
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";

const dataDir = join(root, "bots-data");
const pool = join(dataDir, "bots", "skills");
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
    mkdirSync(join(pool, "polish"), { recursive: true });
    writeFileSync(join(pool, "polish", "SKILL.md"), SKILL);

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

test("a bot gives a session its instructions, model, thinking level, and skills", async () => {
    const id = await pip();
    const folder = folderOf("good");
    const instructions = "Always answer in French. Keep every fact.";

    bot("reviewer", { instructions, skills: ["polish"], model: "faux/faux-1", thinking: "high" });

    const made = await app.pip.startBot(id, { bot: "reviewer", folder });
    const state = await app.agentState(made.id);

    assert.deepEqual(made.installed, ["polish"]);
    assert.deepEqual(made.skipped, []);
    assert.equal(made.folder, folder);
    assert.equal(state?.instructions, instructions);
    assert.equal(state?.model?.modelId, "faux-1");
    // faux-1 has no thinking levels, so the bot's high is lowered to the one it has.
    assert.equal(state?.thinkingLevel, "off");
    assert.equal(app.sessionMeta(made.id)?.bot, "reviewer");
    assert.equal(readFileSync(join(folder, ".pi", "skills", "polish", "SKILL.md"), "utf8"), SKILL);

    // The same bot again, in the same folder: the skill is there as the bot has it, so it stays as it is.
    const again = await app.pip.startBot(id, { bot: "reviewer", folder });

    assert.deepEqual(again.installed, []);
    assert.deepEqual(again.skipped, ["polish"]);
});

test("a bot that names a skill the pool does not have makes no session", async () => {
    const id = await pip();
    const before = app.sessions().length;

    bot("gappy", { skills: ["polish", "absent"], model: "faux/faux-1" });

    await assert.rejects(
        app.pip.startBot(id, { bot: "gappy", folder: folderOf("plain") }),
        /needs the skill “absent”, and .*bots\/skills\/absent has no SKILL\.md/,
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

test("a bot never writes over a folder of the person's own, and names it", async () => {
    const id = await pip();
    const folder = folderOf("taken");
    const mine = join(folder, ".pi", "skills", "polish", "SKILL.md");
    const before = app.sessions().length;

    bot("taken", { skills: ["polish"], model: "faux/faux-1" });
    mkdirSync(join(folder, ".pi", "skills", "polish"), { recursive: true });
    writeFileSync(mine, "Mine, and not the bot's.\n");

    await assert.rejects(
        app.pip.startBot(id, { bot: "taken", folder }),
        /already in this session's folder, as \.pi\/skills\/polish, with files that are not the bot's/,
    );
    assert.equal(app.sessions().length, before, "no session made");
    assert.equal(readFileSync(mine, "utf8"), "Mine, and not the bot's.\n");
});

test("a worktree's skills are checked once its folder is made, and the error names the session", async () => {
    const id = await pip();
    const repo = folderOf("repo");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });

    mkdirSync(repo, { recursive: true });
    git("init", "-q");
    writeFileSync(join(repo, "README.md"), "A repository.\n");
    git("add", "README.md");
    git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "first");
    // A worktree starts with the repository's new files: this skill folder comes with them, and is not the bot's.
    mkdirSync(join(repo, ".pi", "skills", "polish"), { recursive: true });
    writeFileSync(join(repo, ".pi", "skills", "polish", "SKILL.md"), "Mine.\n");

    bot("worktree", { skills: ["polish"], model: "faux/faux-1" });

    const before = app.sessions().length;

    await assert.rejects(
        app.pip.startBot(id, { bot: "worktree", folder: repo, worktree: true }),
        /Session \/s\/\d+ was made in .*without the bot's skills: .*already in this session's folder/,
    );

    const made = app.sessions().find((session) => session.bot === "worktree");

    assert.equal(app.sessions().length, before + 1, "the session was made, as the error says");
    assert.ok(made?.worktree !== undefined, "with its worktree");
    assert.equal(
        (await app.agentState(made!.id as unknown as ConversationId))?.instructions,
        undefined,
    );
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

test("a bot's instructions are as limited as a person's", async () => {
    const id = await pip();
    const before = app.sessions().length;

    bot("long", { instructions: "x".repeat(8001), skills: [], model: "faux/faux-1" });

    await assert.rejects(
        app.pip.startBot(id, { bot: "long", folder: folderOf("plain") }),
        /Instructions are limited to 8000 characters/,
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
    await assert.rejects(
        (async () => readFileSync(join(folder, ".pi", "skills", "polish", "SKILL.md")))(),
        /ENOENT/,
    );
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
            .includes(`Bot “starting”: folder ${folder}. Installed skills: polish.`),
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
