/**
 * Pi's skills for a session's folder. One place: `<dir>/.pi-pocket/skills` in the session's folder and in each folder
 * above it, nearest first, up to the root of its git repository (or `/` outside one). The first skill of a name wins.
 *
 * Pi's own folder and the home folder keep no skills that a session loads: a project's skills are the project's, and a
 * skill for every project lives in the home folder's project, if its person put one there.
 *
 * A project offers its skills only when Pi was told to trust it: its trust store (`trust.json` in Pi's folder) says
 * so for the folder or one above it, or says nothing and Pi's `defaultProjectTrust` setting is "always". No decision,
 * or a "no", keeps them out. Pi Pocket asks its owner (`readProjectTrust` says when) and saves the answer in the same
 * store, with the three answers Pi's `/trust` saves (`saveProjectTrust`).
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadSkills, ProjectTrustStore, type Skill } from "@earendil-works/pi-coding-agent";
import { projectSettingsFile, promptsSubdir, skillsSubdir } from "./paths.ts";

/** What, besides the session's folder, says where skills are. */
export type SkillSources = {
    /** Pi's folder: its `trust.json`, which projects Pi was told to trust or not. */
    agentDir: string;
    /** Pi's `defaultProjectTrust` setting: whether a project nobody decided about is trusted. */
    defaultProjectTrust: "always" | "never" | "ask";
};

/** The root of the git repository `folder` is in, or undefined outside one. */
function gitRoot(folder: string): string | undefined {
    for (let current = folder; ; current = dirname(current)) {
        if (existsSync(join(current, ".git"))) {
            return current;
        }

        if (dirname(current) === current) {
            return undefined;
        }
    }
}

/**
 * The project's skill folders: `<dir>/.pi-pocket/skills` in `cwd` and above it, nearest first, up to the root of its git
 * repository; outside one, only `cwd`'s. The home folder and `/tmp` are never one of them, whatever holds them, and the
 * walk stops there: a project's skills come from the project.
 */
function projectSkillFolders(cwd: string): string[] {
    const top = gitRoot(cwd);
    const stop = top ?? cwd;
    const home = homedir();
    const folders: string[] = [];

    for (let current = cwd; ; current = dirname(current)) {
        const outer = current === home || current === "/tmp";
        const folder = skillsSubdir(current);

        if (!outer && existsSync(folder)) {
            folders.push(folder);
        }

        if (outer || current === stop || dirname(current) === current) {
            return folders;
        }
    }
}

/** The answers Pi's `/trust` offers: trust the folder, trust the folder above it (and so this one too), or not. */
export type TrustChoice = "trust" | "trust-parent" | "distrust";

/** A decision in Pi's trust store: the folder it was saved for, and whether Pi trusts it and the folders in it. */
type Saved = { path: string; trusted: boolean };

/** Whether Pi trusts a session's project, and the project skills that load only while it does. */
export type ProjectTrust = {
    /** The session's folder, as the trust store names it: links resolved. */
    folder: string;
    /** The folder above it, which "trust-parent" trusts; absent at the top. */
    parent?: string;
    /** The decision saved for the folder or the nearest folder above it; null when there is none. */
    saved: Saved | null;
    /** Pi's `defaultProjectTrust` setting: it decides for a folder without a saved decision. */
    defaultProjectTrust: SkillSources["defaultProjectTrust"];
    /** Whether Pi trusts the project now. */
    trusted: boolean;
    /** The project's `.pi-pocket/skills` folders, nearest first. */
    folders: string[];
    /** The skills in them. */
    skills: { name: string; description: string }[];
    /** The skills in its own `.pi-pocket/skills`, which load unless Pi was told not to trust it. */
    ownSkills: { name: string; description: string }[];
    /** The project has a `.pi-pocket/settings.json` file, whose model defaults require trust. */
    settings: boolean;
    /** Whether to ask the owner: project skills or settings exist, no decision applies, and Pi's setting is to ask. */
    ask: boolean;
    /** Pi's trust store cannot be read: nothing is trusted, and no answer can be saved until it is mended. */
    unreadable?: true;
};

/** A folder as the trust store names it: links resolved, when it exists. */
function canonical(folder: string): string {
    try {
        return realpathSync(folder);
    } catch {
        return resolve(folder);
    }
}

/** The decision saved for `cwd` or the nearest folder above it: null for none, undefined for an unreadable store. */
function savedDecision(cwd: string, agentDir: string): Saved | null | undefined {
    try {
        const entry = new ProjectTrustStore(agentDir).getEntry(cwd);

        return entry === null ? null : { path: entry.path, trusted: entry.decision };
    } catch {
        return undefined;
    }
}

/**
 * What Pi decided about a project, as it decides without asking: trusted, not trusted (a saved "no", or
 * `defaultProjectTrust` "never"), or nothing yet, which includes a trust store that cannot be read.
 */
type Decision = "trusted" | "distrusted" | "undecided";

function decides(saved: Saved | null | undefined, sources: SkillSources): Decision {
    if (saved === undefined) {
        return "undecided";
    }

    if (saved !== null) {
        return saved.trusted ? "trusted" : "distrusted";
    }

    return sources.defaultProjectTrust === "always"
        ? "trusted"
        : sources.defaultProjectTrust === "never"
          ? "distrusted"
          : "undecided";
}

/**
 * Whether Pi was told not to trust the project a session in `cwd` works in (a saved "no", or `defaultProjectTrust`
 * "never"), for what of its own `.pi-pocket` folder trust gates: its prompts stay out then, as its skills do. The trust
 * store is read only for a project with prompts.
 */
export function projectDistrusted(cwd: string, sources: SkillSources): boolean {
    const folder = resolve(cwd);

    return (
        existsSync(promptsSubdir(folder)) &&
        decides(savedDecision(folder, sources.agentDir), sources) === "distrusted"
    );
}

/**
 * Where a session in `cwd` loads skills from: its project's folders, nearest first, and only when Pi was told to trust
 * that project. A project with no decision, or a "no", offers none of its skills.
 */
export function skillPlaces(cwd: string, sources: SkillSources): string[] {
    const folder = resolve(cwd);

    return decides(savedDecision(folder, sources.agentDir), sources) === "trusted"
        ? projectSkillFolders(folder)
        : [];
}

/** Pi's skills for a session in `cwd`: the first of each name, from `skillPlaces`. */
export function loadSessionSkills(cwd: string, sources: SkillSources): Skill[] {
    return loadSkills({
        cwd,
        agentDir: sources.agentDir,
        skillPaths: skillPlaces(cwd, sources),
        includeDefaults: false,
    }).skills;
}

/** Whether Pi trusts the project a session in `cwd` works in, and the project skills that wait for it. */
export function readProjectTrust(cwd: string, sources: SkillSources): ProjectTrust {
    const folder = canonical(cwd);
    const parent = dirname(folder);
    const saved = savedDecision(cwd, sources.agentDir);
    const folders = projectSkillFolders(resolve(cwd));
    const own = skillsSubdir(resolve(cwd));
    const skillsIn = (paths: string[]) =>
        paths.length === 0
            ? []
            : loadSkills({
                  cwd,
                  agentDir: sources.agentDir,
                  skillPaths: paths,
                  includeDefaults: false,
              }).skills.map(({ name, description }) => ({ name, description }));
    const skills = skillsIn(folders);
    const ownSkills = skillsIn(existsSync(own) ? [own] : []);
    const settings = existsSync(projectSettingsFile(folder));

    return {
        folder,
        ...(parent === folder ? {} : { parent }),
        saved: saved ?? null,
        defaultProjectTrust: sources.defaultProjectTrust,
        trusted: decides(saved, sources) === "trusted",
        folders,
        skills,
        ownSkills,
        settings,
        // Empty skill folders do not ask, but a settings-only project does. An unreadable trust store cannot save.
        ask:
            (skills.length > 0 || settings) &&
            saved === null &&
            sources.defaultProjectTrust === "ask",
        ...(saved === undefined ? { unreadable: true as const } : {}),
    };
}

/** Save an answer to "trust this project?" for a session in `cwd` in Pi's trust store, as Pi's `/trust` saves it. */
export function saveProjectTrust(cwd: string, agentDir: string, choice: TrustChoice): void {
    const folder = canonical(cwd);
    const parent = dirname(folder);
    const store = new ProjectTrustStore(agentDir);

    if (choice !== "trust-parent") {
        store.set(folder, choice === "trust");

        return;
    }

    if (parent === folder) {
        throw new Error(`${folder} has no folder above it.`);
    }

    // The folder's own decision goes, so the one for the folder above applies to it.
    store.setMany([
        { path: parent, decision: true },
        { path: folder, decision: null },
    ]);
}
