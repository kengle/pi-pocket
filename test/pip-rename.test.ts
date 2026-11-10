// PiP renames a session: through the same path a person's rename takes, so its title in the list and in links
// changes, and its chat says who renamed it; a blank title is refused, and a conversation PiP cannot see is answered
// as one that is not there.
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
} from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { ChatDoc } from "../src/server/docs.ts";

/** PiP renames the session its person names, with the title they say. */
const route: FauxResponseStep = (request) => {
    const { role, text: written } = lastText(request as never);
    const text = written.replace(/^\[from: [^\]]+\] /, "");
    const asked = /^rename (\d+) (.+)$/.exec(text);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`done: ${text}`)]);
    }

    return asked === null
        ? fauxAssistantMessage([fauxText(`echo: ${text}`)])
        : fauxAssistantMessage(
              [fauxToolCall("session_rename", { session: Number(asked[1]), title: asked[2]! })],
              { stopReason: "toolUse" },
          );
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

before(async () => {
    app = await openApp(model, join(root, "pip-rename-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("PiP renames a session, and the list and its chat say so", async () => {
    const id = await pip();
    const session = await newSession(app);

    await say(app, id, `rename ${String(session)} A better title`);

    assert.equal(app.sessionMeta(session)?.title, "A better title");
    assert.match(
        (await said(id)).join("\n"),
        new RegExp(`done: Renamed /s/${String(session)} to “A better title”\\.`),
    );
    // The session's chat says who renamed it: its person, through PiP.
    const chat = await app.harness.snapshot(ChatDoc, session, context);

    assert.ok(
        chat?.messages.some(
            (message) => message.text === "renamed the session to “A better title”",
        ),
    );
    assert.equal(app.sessionMeta(session)?.createdBy, owner(app).id, "still the owner's session");
});

test("a blank title is refused, and the title stays as it was", async () => {
    const id = await pip();
    const session = await newSession(app);
    const before = app.sessionMeta(session)?.title;

    await assert.rejects(app.pip.rename(id, Number(session), "   "), /A title needs some text/);
    assert.equal(app.sessionMeta(session)?.title, before);
});

test("a conversation PiP cannot see is answered as one that is not there", async () => {
    const id = await pip();
    // A conversation of the app's own, outside the session list: no title, no place in it.
    const hidden = await app.harness.createConversation(
        { ownership: { kind: "ownerless" } },
        context,
    );

    await assert.rejects(
        app.pip.rename(id, Number(hidden.id), "Anything"),
        new RegExp(
            `There is no session ${String(hidden.id)}\\. List them with the sessions tool\\.`,
        ),
    );
});

test("an id that is not there is answered with the way to find one", async () => {
    const id = await pip();

    await assert.rejects(
        app.pip.rename(id, 999_999, "Anything"),
        /There is no session 999999\. List them with the sessions tool\./,
    );
});
