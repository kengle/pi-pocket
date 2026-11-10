// PiP compacts a session's context, through the compaction the app's own button uses: what to keep goes with it, blank
// text is no note at all, too long is refused, a conversation PiP cannot see is answered as one that is not there, and a
// session at work is left until it is idle.
import {
    type App,
    cleanUp,
    context,
    lastText,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { type ConversationId, LiveDoc } from "@earendil-works/pi-durable";
import { ChatDoc } from "../src/server/docs.ts";

/** Set while a session's "hold" run waits: calling it lets the run end. */
let release: (() => void) | undefined;

/** PiP compacts the session its person names; a session's "hold" waits until it is let go. */
const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text: written } = lastText(request as never);
    const text = written.replace(/^\[from: [^\]]+\] /, "");

    if (all.includes("You are PiP")) {
        if (role === "toolResult") {
            return fauxAssistantMessage([fauxText(`done: ${text}`)]);
        }

        const asked = /^compact (\d+)(?: keep (.+))?$/.exec(text);

        return asked === null
            ? fauxAssistantMessage([fauxText(`pip: ${text}`)])
            : fauxAssistantMessage(
                  [
                      fauxToolCall("session_compact", {
                          session: Number(asked[1]),
                          ...(asked[2] === undefined ? {} : { keep: asked[2] }),
                      }),
                  ],
                  { stopReason: "toolUse" },
              );
    }

    if (text === "hold") {
        return new Promise((done) => {
            release = () => done(fauxAssistantMessage([fauxText("held")]));
        });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

const model = scriptedModel(route);
let app: App;

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

/** Whether a compaction of the session is under way. */
const compacting = async (id: ConversationId) =>
    ((await app.harness.snapshot(LiveDoc, id, context))?.compactions ?? []).length > 0;

before(async () => {
    app = await openApp(model, join(root, "pip-session-compact-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("PiP compacts a session, and what to keep goes with it", async () => {
    const id = await pip();
    const session = await newSession(app);

    await say(app, session, "The release goes out on Friday.");

    await say(app, id, `compact ${String(session)} keep the release day`);

    assert.match(
        (await said(id)).join("\n"),
        new RegExp(`done: Compacting /s/${String(session)}\\.`),
    );
    // The session's chat says a compaction started, as the app's own button says it.
    const chat = await app.harness.snapshot(ChatDoc, session, context);

    assert.ok(chat?.messages.some((message) => message.text === "started compacting the context"));
    await until(async () => !(await compacting(session)), "the compaction over");
});

test("PiP compacts a session with nothing to keep", async () => {
    const id = await pip();
    const session = await newSession(app);

    await say(app, session, "Some context for later.");

    await say(app, id, `compact ${String(session)}`);

    assert.match(
        (await said(id)).join("\n"),
        new RegExp(`done: Compacting /s/${String(session)}\\.`),
    );
    await until(async () => !(await compacting(session)), "the compaction over");
    // Blank text is no note at all, as the app's own compact route takes it.
    await app.pip.compact(id, Number(session), "   ");
});

test("a note of what to keep is as limited as a handoff note", async () => {
    const id = await pip();
    const session = await newSession(app);

    await assert.rejects(
        app.pip.compact(id, Number(session), "x".repeat(20_001)),
        /What to keep is limited to 20000 characters\./,
    );
});

test("a conversation PiP cannot see is answered as one that is not there", async () => {
    const id = await pip();
    // A conversation of the app's own, outside the session list.
    const hidden = await app.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
    );

    await assert.rejects(
        app.pip.compact(id, Number(hidden.id), undefined),
        new RegExp(
            `There is no session ${String(hidden.id)}\\. List them with the sessions tool\\.`,
        ),
    );
});

test("an id that is not there is answered with the way to find one", async () => {
    const id = await pip();

    await assert.rejects(
        app.pip.compact(id, 999_999, undefined),
        /There is no session 999999\. List them with the sessions tool\./,
    );
});

test("a session that is working is left alone until it is idle", async () => {
    const id = await pip();
    const session = await newSession(app);
    const { submissionId } = await app.commands.submit(session, owner(app), {
        text: "hold",
        requestId: "hold-1",
    });

    await until(() => release !== undefined, "the session at its model request");
    await assert.rejects(
        app.pip.compact(id, Number(session), undefined),
        new RegExp(`/s/${String(session)} is working: wait until it is idle, then compact it\\.`),
    );

    release?.();
    await (await app.harness.submission(submissionId, context))!.wait(context);
});
