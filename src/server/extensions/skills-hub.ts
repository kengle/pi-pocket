/**
 * Skills hub for Pi Pocket: a git repository of skills, and the two read-only tools Pi uses over it. `skills_list`
 * finds a skill by words or tag, with its folder and the commit that last touched it; `skills_get` returns a skill's
 * SKILL.md, its folder, and one line to start its script. The tools read `<hub>/skills/<name>/SKILL.md` and write only
 * the index `<hub>/hub.json`, whose hit needs each SKILL.md's size and time unchanged.
 *
 * The hub folder is `~/.pi-pocket/skills-hub` unless the owner sets `hubPath` in Extensions. Nothing here runs a skill:
 * a person or Pi runs the line that `skills_get` suggests, in that folder.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ExtensionWeb, PocketHost } from "../host.ts";

/** This module returns `output`, which needs version 2 of the extension API. */
export const pocketApi = 2;

/** Where the hub is when the owner names no other folder. */
const DEFAULT_HUB = join(homedir(), ".pi-pocket", "skills-hub");
/** The skills of a list, and the lines of a description, that go to the model at most. */
const MAX_SKILLS = 20;
const MAX_TEXT = 40_000;

type Skill = {
    name: string;
    description: string;
    tags: string[];
    hasScripts: boolean;
    /** The skill's folder, absolute. */
    path: string;
};

/**
 * What the index holds: the scan, the hub's commit, and each skill's last commit by relative folder. A hit needs the
 * same hub commit and every SKILL.md's size and time unchanged; then no `git log` runs at all.
 */
type Index = {
    generatedAt: number;
    head: string;
    skills: (Skill & { size: number; mtimeMs: number })[];
    shaByPath: Record<string, string>;
};

const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });

/** One value of a line's frontmatter: `[a, b]`, `a, b`, or a word. */
function listOf(value: string): string[] {
    const bare = value.trim().replace(/^\[/, "").replace(/\]$/, "");

    return bare
        .split(",")
        .map((each) => each.trim().replace(/^["']|["']$/g, ""))
        .filter((each) => each !== "");
}

/**
 * The frontmatter of a SKILL.md: the `key: value` lines between the first two `---` lines, where `tags` may be a list
 * with `- item` lines under it. What a skill does not say comes back empty.
 */
function frontmatter(text: string): Map<string, string[]> {
    const found = new Map<string, string[]>();
    const lines = text.split(/\r?\n/);

    if (lines[0]?.trim() !== "---") {
        return found;
    }

    let key: string | undefined;

    for (const line of lines.slice(1)) {
        if (line.trim() === "---") {
            break;
        }

        const item = /^\s*-\s+(.*)$/.exec(line);

        if (item !== null && key !== undefined) {
            found.set(key, [
                ...(found.get(key) ?? []),
                item[1]!.trim().replace(/^["']|["']$/g, ""),
            ]);
            continue;
        }

        const field = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);

        if (field === null) {
            continue;
        }

        key = field[1]!;

        if (field[2]!.trim() !== "") {
            found.set(key, listOf(field[2]!));
        }
    }

    return found;
}

/** The one value a field has, as a line: the first of its list. */
const one = (values: string[] | undefined): string => (values ?? []).join(", ");

/** Every skill folder of the hub, as its SKILL.md says it, in name order. */
function scan(hub: string): (Skill & { size: number; mtimeMs: number })[] {
    const root = join(hub, "skills");
    const skills: (Skill & { size: number; mtimeMs: number })[] = [];

    for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
    )) {
        const dir = join(root, entry.name);
        const file = join(dir, "SKILL.md");

        if (!entry.isDirectory() || !existsSync(file)) {
            continue;
        }

        const text = readFileSync(file, "utf8");
        const fields = frontmatter(text);
        const stat = statSync(file);
        const scripts = join(dir, "scripts");

        skills.push({
            name: one(fields.get("name")) || entry.name,
            description: one(fields.get("description")),
            tags: fields.get("tags") ?? [],
            hasScripts: existsSync(scripts) && readdirSync(scripts).length > 0,
            path: resolve(dir),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
        });
    }

    return skills;
}

/** The commit that last touched a skill's folder, short; "none" before the hub's first commit. */
function shaOf(hub: string, folder: string): string {
    try {
        return (
            execFileSync("git", ["-C", hub, "log", "-1", "--format=%h", "--", folder], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim() || "none"
        );
    } catch {
        return "none";
    }
}

/** The hub's commit, short; "none" before its first commit. The one `git` call that a cache hit makes. */
function headOf(hub: string): string {
    try {
        return (
            execFileSync("git", ["-C", hub, "rev-parse", "--short", "HEAD"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim() || "none"
        );
    } catch {
        return "none";
    }
}

/**
 * The hub's index: `hub.json` while the hub's commit and every SKILL.md are as they were, else made again, its commits
 * read once per skill, and written there.
 */
function indexOf(hub: string): Index {
    const head = headOf(hub);
    const cached = readCached(hub, head);

    if (cached !== undefined) {
        return cached;
    }

    const skills = scan(hub);
    const shaByPath: Record<string, string> = {};

    for (const skill of skills) {
        const folder = relative(hub, skill.path);

        shaByPath[folder] = shaOf(hub, folder);
    }

    const made: Index = { generatedAt: Date.now(), head, skills, shaByPath };

    try {
        writeFileSync(join(hub, "hub.json"), `${JSON.stringify(made, null, 1)}\n`);
    } catch {
        // The tools still answer: the next call scans again.
    }

    return made;
}

/** The stored index, when the hub's commit is the same and every SKILL.md keeps its size and time. */
function readCached(hub: string, head: string): Index | undefined {
    let stored: Index;

    try {
        stored = JSON.parse(readFileSync(join(hub, "hub.json"), "utf8")) as Index;
    } catch {
        return undefined;
    }

    if (!Array.isArray(stored?.skills) || stored.head !== head) {
        return undefined;
    }

    const scanned = scan(hub);

    if (scanned.length !== stored.skills.length) {
        return undefined;
    }

    const same = scanned.every((skill, at) => {
        const was = stored.skills[at]!;

        return (
            was.name === skill.name &&
            was.size === skill.size &&
            was.mtimeMs === skill.mtimeMs &&
            was.path === skill.path
        );
    });

    return same ? { ...stored, skills: scanned.map((skill, at) => ({ ...skill })) } : undefined;
}

/** The line that starts a skill's first script, `.py` first; undefined when it has none. */
function startLine(dir: string): string | undefined {
    const scripts = join(dir, "scripts");

    if (!existsSync(scripts)) {
        return undefined;
    }

    const names = readdirSync(scripts).sort();
    const python = names.find((name) => name.endsWith(".py"));
    const shell = names.find((name) => name.endsWith(".sh"));

    if (python !== undefined) {
        return `cd ${dir} && python3 scripts/${python}`;
    }

    return shell === undefined ? undefined : `cd ${dir} && bash scripts/${shell}`;
}

/** One skill as a line of a list: its name, its tags, its folder, and the first line of its description. */
function lineOf(skill: Skill): string {
    return `- ${skill.name}${skill.hasScripts ? " · scripts" : ""}${skill.tags.length === 0 ? "" : ` · tags: ${skill.tags.join(", ")}`}\n  ${skill.path}\n  ${skill.description.trim().split(/\r?\n/)[0] ?? ""}`;
}

export default function createSkillsHub(host: PocketHost, web: ExtensionWeb) {
    void host;

    web.settings([
        {
            name: "hubPath",
            label: "Skills hub",
            description: "The git repository of skills (default ~/.pi-pocket/skills-hub)",
            type: "text",
            placeholder: DEFAULT_HUB,
        },
    ]);

    /** The hub folder now: the owner's setting, else the default. */
    const hub = (): string => {
        const chosen = web.setting("hubPath");

        return typeof chosen === "string" && chosen.trim() !== ""
            ? resolve(chosen.trim())
            : DEFAULT_HUB;
    };

    const list = defineTool({
        name: "skills_list",
        description:
            "List the skills of the owner's skills hub, which is a git repository: their names, descriptions, tags, folders, and the commit that last touched each. Give `query` to find words in names and descriptions, `tag` for one tag, `limit` for how many (default 20). Then read one with skills_get.",
        parameters: obj(
            {
                query: opt(str({ description: "Words to find in names and descriptions" })),
                tag: opt(str({ description: "One tag, as it is written" })),
                limit: opt(num({ description: "How many skills, at most 20 (default 20)" })),
            },
            { open: true },
        ),
        replay: "safe",
        execute: async (args) => {
            const root = hub();

            if (!existsSync(join(root, "skills"))) {
                throw new Error(
                    `The skills hub is not there: ${root} has no skills folder. Set hubPath in Extensions, or make that folder.`,
                );
            }

            const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
            const tag = args.tag?.trim();
            const limit = Math.min(MAX_SKILLS, Math.max(1, Math.trunc(args.limit ?? MAX_SKILLS)));
            const index = indexOf(root);
            const found = index.skills
                .filter(
                    (skill) =>
                        words.every((word) =>
                            `${skill.name} ${skill.description}`.toLowerCase().includes(word),
                        ) &&
                        (tag === undefined || skill.tags.includes(tag)),
                )
                .slice(0, limit)
                .map(lineOf);

            return reply(
                found.length === 0
                    ? `hub @ ${index.head} · no skill of ${root} matches.`
                    : `hub @ ${index.head} · ${String(found.length)} skill${found.length === 1 ? "" : "s"} of ${root}:\n${found.join("\n")}`,
            );
        },
    });

    const get = defineTool({
        name: "skills_get",
        description:
            "Read one skill of the owner's skills hub: its SKILL.md, its folder, and one line that starts its script when it has one. Find the name with skills_list.",
        parameters: obj(
            { name: str({ description: "The skill's name, as skills_list gives it" }) },
            { open: true },
        ),
        replay: "safe",
        execute: async (args) => {
            const root = hub();
            const name = args.name.trim();
            const skill = existsSync(join(root, "skills"))
                ? indexOf(root).skills.find((each) => each.name === name)
                : undefined;

            if (skill === undefined) {
                throw new Error(
                    `The skills hub ${root} has no skill called "${name}". Find one with skills_list.`,
                );
            }

            const text = readFileSync(join(skill.path, "SKILL.md"), "utf8");
            const cut =
                text.length > MAX_TEXT
                    ? `${text.slice(0, MAX_TEXT)}\n\n[cut: ${String(MAX_TEXT)} of ${String(text.length)} characters]`
                    : text;
            const start = startLine(skill.path);
            const head = [
                `# ${skill.name}`,
                `Folder: ${skill.path}`,
                `Commit: ${shaOf(root, relative(root, skill.path))}`,
                ...(start === undefined ? [] : [`Start: ${start}`]),
            ];

            return reply(`${head.join("\n")}\n\n${cut}`);
        },
    });

    return defineExtension({ name: "skills-hub", tools: [list, get] });
}
