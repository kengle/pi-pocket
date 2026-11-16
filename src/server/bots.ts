/**
 * Predefined bots, for PiP to start a session with: a file in the data folder's `bots/` (`<name>.json`) holding what Pi
 * is told in every request of the session, the names of the skills it gets from the skills hub (`hub.ts`), and how it
 * runs (its model and thinking level). A bot is read and checked before any session is made, so a bot that cannot be
 * given in full leaves none behind: a skill it names that the hub does not have stops the call. Nothing is copied into
 * the session's folder: the session reads a hub skill where the hub keeps it, and the person's own copy of a skill in the
 * project stays theirs. Whether the model works here is for the caller to check: it knows the models signed in.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MAX_INSTRUCTIONS } from "./commands.ts";
import { describe, HttpError } from "./errors.ts";
import { quoted } from "./fence.ts";
import type { Hub } from "./hub.ts";
import { isThinkingLevel, THINKING_LEVELS } from "./models.ts";
import { homePath } from "./paths.ts";

/**
 * A bot as its file says it: what Pi is told in every request of the session, the skills it gets from the hub, and the
 * model it runs on with the thinking level it starts at.
 */
export type Bot = {
    instructions: string;
    skills: string[];
    /** A model as the file names it, `provider/modelId` or a bare id: the session starts where it resolves and is signed in. */
    model: string;
    thinking?: ModelThinkingLevel;
};

/** What a bot's skills came to: those the hub has, and those it does not. */
export type BotInstall = { hub: string[]; missing: string[] };

/** Whether a name is one name inside the bots folder: never a path, so nothing outside it is read or written. */
const isOneName = (name: string) =>
    name !== "" && name !== "." && name !== ".." && !/[/\\]/.test(name);

/** The bots there are, as an error says them: the `.json` files in the data folder's `bots/`. */
function botsHere(dataDir: string): string {
    let names: string[];

    try {
        names = readdirSync(join(dataDir, "bots"))
            .filter((each) => each.endsWith(".json"))
            .map((each) => each.slice(0, -".json".length))
            .sort();
    } catch {
        names = [];
    }

    return names.length === 0
        ? "There are no bots in the bots folder yet."
        : `The bots there are: ${names.map((each) => quoted(each)).join(", ")}.`;
}

/** The hub's skills, as an error says them: their names, or that it has none. */
function hubHere(hub: Hub): string {
    const names = [...hub.skills.keys()];

    return names.length === 0
        ? `The skills hub (${homePath(hub.folder)}) has no skills yet.`
        : `The skills hub (${homePath(hub.folder)}) has: ${names.map((each) => quoted(each)).join(", ")}.`;
}

/**
 * The bot named `bot` in the data folder, read and checked: its instructions, at most as long as a person may set them,
 * its skills, each one a skill of the hub, and its model and thinking level. A name that is not there, bad JSON, or a
 * skill the hub does not have is an error that says so, and stops the call before any session is made.
 */
export function readBot(dataDir: string, bot: string, hub: Hub): Bot {
    const name = bot.trim();

    if (!isOneName(name)) {
        throw new HttpError(
            400,
            `A bot's name must be one name in the bots folder, not a path: ${quoted(bot)}. ${botsHere(dataDir)}`,
        );
    }

    const file = join(dataDir, "bots", `${name}.json`);
    let raw: string;

    try {
        raw = readFileSync(file, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw new HttpError(404, `The bot ${quoted(name)} cannot be read: ${describe(error)}`);
        }

        throw new HttpError(404, `There is no bot ${quoted(name)}. ${botsHere(dataDir)}`);
    }

    let value: unknown;

    try {
        value = JSON.parse(raw) as unknown;
    } catch (error) {
        throw new HttpError(400, `The bot ${quoted(name)} is not valid JSON: ${describe(error)}`);
    }

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new HttpError(
            400,
            `The bot ${quoted(name)} must be an object, with instructions, skills, and model.`,
        );
    }

    const { instructions, skills, model, thinking } = value as {
        instructions?: unknown;
        skills?: unknown;
        model?: unknown;
        thinking?: unknown;
    };

    if (instructions !== undefined && typeof instructions !== "string") {
        throw new HttpError(400, `The instructions of bot ${quoted(name)} must be text.`);
    }

    const text = (instructions ?? "").trim();

    if (text.length > MAX_INSTRUCTIONS) {
        throw new HttpError(413, `Instructions are limited to ${MAX_INSTRUCTIONS} characters`);
    }

    if (skills !== undefined && !Array.isArray(skills)) {
        throw new HttpError(400, `The skills of bot ${quoted(name)} must be a list of names.`);
    }

    const named = (skills ?? []).map((each: unknown) => {
        const skill = typeof each === "string" ? each.trim() : "";

        if (!isOneName(skill)) {
            throw new HttpError(
                400,
                `A skill of bot ${quoted(name)} must be one name in the skills hub, not a path: ${quoted(String(each))}`,
            );
        }

        if (!hub.skills.has(skill)) {
            throw new HttpError(
                400,
                `The bot ${quoted(name)} needs the skill ${quoted(skill)}, and the skills hub has none of that name: ${homePath(join(hub.folder, "skills", skill))} has no SKILL.md. ${hubHere(hub)}`,
            );
        }

        return skill;
    });

    if (typeof model !== "string" || model.trim() === "") {
        throw new HttpError(
            400,
            `The bot ${quoted(name)} must name a model, as provider/modelId: without one it cannot start a session.`,
        );
    }

    if (thinking !== undefined && (typeof thinking !== "string" || !isThinkingLevel(thinking))) {
        throw new HttpError(
            400,
            `The thinking level of bot ${quoted(name)} must be one of ${THINKING_LEVELS.join(", ")}: ${quoted(String(thinking))} is not.`,
        );
    }

    return {
        instructions: text,
        skills: named,
        model: model.trim(),
        ...(thinking === undefined ? {} : { thinking: thinking as ModelThinkingLevel }),
    };
}

/**
 * A bot's skills, as the hub has them now: the names it answers to, and those it does not have (the hub may have changed
 * since the bot was read). Nothing is written: the session reads them where they are.
 */
export function botSkills(hub: Hub, skills: readonly string[]): BotInstall {
    const found: string[] = [];
    const missing: string[] = [];

    for (const name of skills) {
        (hub.skills.has(name) ? found : missing).push(name);
    }

    return { hub: found, missing };
}
