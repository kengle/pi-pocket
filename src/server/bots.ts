/**
 * Predefined bots, for PiP to start a session with: a file in the data folder's `bots/` (`<name>.json`) holding what Pi
 * is told in every request of the session, the names of the skills it gets, and how it runs (its model and thinking
 * level); and a pool of skills in `bots/skills/`, each a folder with a `SKILL.md`. A bot is read and checked before any
 * session is made, so a bot that cannot be given in full leaves none behind. Its skills are then copied into the
 * session's folder as `.pi/skills/<name>/`, where Pi loads them, and a folder already there with other files is never
 * overwritten: `checkSkills` says before a session is made that they can go in. Whether the model works here is for the
 * caller to check: it knows the models signed in.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MAX_INSTRUCTIONS } from "./commands.ts";
import { describe, HttpError } from "./errors.ts";
import { quoted } from "./fence.ts";
import { isThinkingLevel, THINKING_LEVELS } from "./models.ts";
import { displayPath, homePath } from "./paths.ts";

/**
 * A bot as its file says it: what Pi is told in every request of the session, the skills its folder gets, and the model
 * it runs on with the thinking level it starts at.
 */
export type Bot = {
    instructions: string;
    skills: string[];
    /** A model as the file names it, `provider/modelId` or a bare id: the session starts where it resolves and is signed in. */
    model: string;
    thinking?: ModelThinkingLevel;
};

/** What installing a bot's skills came to: the folders written, and those already there as the bot has them. */
export type BotInstall = { installed: string[]; skipped: string[] };

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

/**
 * The bot named `bot` in the data folder, read and checked: its instructions, at most as long as a person may set them,
 * its skills, each one a folder with a `SKILL.md` in the pool, and its model and thinking level. A name that is not
 * there, bad JSON, or a skill that is not there is an error that says so, and stops the call before any session is
 * made.
 */
export function readBot(dataDir: string, bot: string): Bot {
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

    const pool = join(dataDir, "bots", "skills");
    const named = (skills ?? []).map((each: unknown) => {
        const skill = typeof each === "string" ? each.trim() : "";

        if (!isOneName(skill)) {
            throw new HttpError(
                400,
                `A skill of bot ${quoted(name)} must be one name in the bots folder, not a path: ${quoted(String(each))}`,
            );
        }

        if (!existsSync(join(pool, skill, "SKILL.md"))) {
            throw new HttpError(
                400,
                `The bot ${quoted(name)} needs the skill ${quoted(skill)}, and ${homePath(join(pool, skill))} has no SKILL.md.`,
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
 * Whether a name is not part of a skill: compiled caches (`__pycache__`, `.pyc`, `.pyo`), and what a file system or a
 * clone left behind (`.DS_Store`, `.git`). A copy leaves them out, and a comparison does not read them, so a pool with
 * caches and a folder without them are the same skill.
 */
function ignored(name: string): boolean {
    return (
        name === "__pycache__" ||
        name === ".git" ||
        name === ".DS_Store" ||
        name.endsWith(".pyc") ||
        name.endsWith(".pyo")
    );
}

/** A folder's entries that a skill has, sorted: what a copy writes, and what a comparison reads. */
function entriesOf(folder: string): string[] {
    return readdirSync(folder, { withFileTypes: true })
        .filter((entry) => !ignored(entry.name))
        .map((entry) => `${entry.isDirectory() ? "folder" : "file"}:${entry.name}`)
        .sort();
}

/** Whether two folders hold the same files, at the same places, with the same contents: caches left out of both. */
function sameFolder(left: string, right: string): boolean {
    const names = entriesOf(left);

    if (names.join("\n") !== entriesOf(right).join("\n")) {
        return false;
    }

    return names.every((each) => {
        const name = each.slice(each.indexOf(":") + 1);
        const from = join(left, name);
        const to = join(right, name);

        return each.startsWith("folder:")
            ? sameFolder(from, to)
            : readFileSync(from).equals(readFileSync(to));
    });
}

/**
 * The error for a skill whose folder in `cwd` is not the bot's own: nothing is overwritten, and the folder is named.
 */
function conflict(name: string, target: string, cwd: string): HttpError {
    return new HttpError(
        409,
        `The skill ${quoted(name)} is already in this session's folder, as ${displayPath(target, cwd)}, with files that are not the bot's: nothing is overwritten. Move it away, or start the bot in another folder.`,
    );
}

/**
 * Whether a bot's skills can go into `cwd`: each one either not there yet, or there as the bot has it. One whose folder
 * holds other files is an error that names it; one that holds only caches has nothing of its own yet, and can take the
 * skill. This reads only, so a caller can ask before it makes a session.
 */
export function checkSkills(dataDir: string, cwd: string, skills: readonly string[]): void {
    for (const name of skills) {
        const target = join(cwd, ".pi", "skills", name);

        if (
            existsSync(target) &&
            entriesOf(target).length > 0 &&
            !sameFolder(join(dataDir, "bots", "skills", name), target)
        ) {
            throw conflict(name, target, cwd);
        }
    }
}

/**
 * A bot's skills, in a session's folder: each one copied from the pool to `<cwd>/.pi/skills/<name>/`, without the caches
 * no skill needs. A folder already there as the bot has it is skipped, since the session has that skill already; one
 * holding only caches gets the skill; one with files of its own stops the call, naming it, because a folder in someone's
 * project is theirs to keep.
 */
export function installSkills(dataDir: string, cwd: string, skills: readonly string[]): BotInstall {
    const pool = join(dataDir, "bots", "skills");
    const installed: string[] = [];
    const skipped: string[] = [];

    for (const name of skills) {
        const source = join(pool, name);
        const target = join(cwd, ".pi", "skills", name);
        const there = existsSync(target);

        if (there && sameFolder(source, target)) {
            skipped.push(name);
            continue;
        }

        if (there && entriesOf(target).length > 0) {
            throw conflict(name, target, cwd);
        }

        mkdirSync(dirname(target), { recursive: true });
        cpSync(source, target, {
            recursive: true,
            filter: (from: string) => !ignored(basename(from)),
        });
        installed.push(name);
    }

    return { installed, skipped };
}
