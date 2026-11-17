/**
 * The owner's skills hub: a git repository of skills, one folder per skill under its `skills/`, each with a `SKILL.md`
 * whose frontmatter says what it is for. A bot names the skills it wants from there (`bots.ts`), and its session is told
 * them with the hub's commit: nothing is copied into the session's folder, so one copy serves every session that names
 * it, and the session reads it with the hub's tools (`skills_list`, `skills_get`). A skill of the same name in the
 * project's own `.pi-pocket/skills/` is the one the session follows. The hub folder is the data folder's `skills-hub/`,
 * unless the owner sets `hubPath` in the skills-hub extension's settings.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** One skill as the hub holds it, and as its `SKILL.md` says what it is for. */
export type HubSkill = { name: string; description: string; folder: string };

/** The hub as it is now: its folder, its short commit (`none` before the first one), and its skills by name. */
export type Hub = { folder: string; head: string; skills: Map<string, HubSkill> };

/** The hub folder: the owner's setting when it is set, else the data folder's `skills-hub/`. */
export function hubFolder(dataDir: string, chosen: unknown): string {
    const given = typeof chosen === "string" ? chosen.trim() : "";

    return given === "" ? join(dataDir, "skills-hub") : resolve(given);
}

/** The hub's commit, short: the one thing read from git. `none` when the hub is not a repository yet. */
function headOf(folder: string): string {
    try {
        return (
            execFileSync("git", ["-C", folder, "rev-parse", "--short", "HEAD"], {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 5000,
            }).trim() || "none"
        );
    } catch {
        return "none";
    }
}

/**
 * A `SKILL.md`'s description, on one line: the frontmatter's `description`, which may run on in a `>` or `|` block. What
 * a skill does not say comes back empty.
 */
function descriptionOf(text: string): string {
    const lines = text.split(/\r?\n/);

    if (lines[0]?.trim() !== "---") {
        return "";
    }

    const parts: string[] = [];
    let inside = false;

    for (const line of lines.slice(1)) {
        if (line.trim() === "---") {
            break;
        }

        if (inside) {
            if (/^\s+\S/.test(line)) {
                parts.push(line.trim());
                continue;
            }

            break;
        }

        const field = /^description\s*:\s*(.*)$/.exec(line);

        if (field === null) {
            continue;
        }

        const value = field[1]!.trim();

        if (value === ">" || value === "|" || value === ">-" || value === "|-") {
            inside = true;
            continue;
        }

        return value.replace(/^["']|["']$/g, "").trim();
    }

    return parts.join(" ").trim();
}

/** The newest of git's own pointers: HEAD, the ref it names, and packed refs. 0 when none is readable. */
function headStamp(folder: string): number {
    const git = join(folder, ".git");
    const files = [join(git, "HEAD"), join(git, "packed-refs")];

    try {
        const match = /^ref:\s*(\S+)$/.exec(readFileSync(join(git, "HEAD"), "utf8").trim());

        if (match !== null) {
            files.push(join(git, match[1]!));
        }
    } catch {
        // Not a repository, or no HEAD to read: `headOf` says "none".
    }

    let stamp = 0;

    for (const file of files) {
        try {
            stamp = Math.max(stamp, statSync(file).mtimeMs);
        } catch {
            // A pointer that is not there changes nothing.
        }
    }

    return stamp;
}

const heads = new Map<string, { stamp: number; head: string }>();

/**
 * The hub's commit, short, reused while git's own pointers are unchanged: a session's prompt asks for it on every
 * request, and `git rev-parse` is a process each time. A hub whose pointers cannot be read runs it anyway.
 */
export function hubHead(folder: string): string {
    const stamp = headStamp(folder);

    if (stamp === 0) {
        return headOf(folder);
    }

    const cached = heads.get(folder);

    if (cached !== undefined && cached.stamp === stamp) {
        return cached.head;
    }

    const head = headOf(folder);

    heads.set(folder, { stamp, head });

    return head;
}

/** Whether the hub has a skill of that name now: its folder has a `SKILL.md`. */
export function hubHas(folder: string, name: string): boolean {
    return existsSync(join(folder, "skills", name, "SKILL.md"));
}

/** The hub's skills, read from disk now: a folder under `skills/` with a `SKILL.md` is one. */
export function readHub(folder: string): Hub {
    const skills = new Map<string, HubSkill>();
    let entries: string[] = [];

    try {
        entries = readdirSync(join(folder, "skills"), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
    } catch {
        entries = [];
    }

    for (const name of entries) {
        const dir = join(folder, "skills", name);
        const file = join(dir, "SKILL.md");

        if (!existsSync(file)) {
            continue;
        }

        skills.set(name, {
            name,
            description: descriptionOf(readFileSync(file, "utf8")),
            folder: dir,
        });
    }

    return { folder, head: headOf(folder), skills };
}
