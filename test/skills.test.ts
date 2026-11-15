// Pi Pocket's skills: one place, `<dir>/.pi-pocket/skills` from the session's folder up to the repository's root, the
// nearest of a name first; no skills from `.agents`, Pi's folder, or Pi's settings; and project trust on top.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
    loadSessionSkills,
    projectDistrusted,
    readProjectTrust,
    saveProjectTrust,
    type SkillSources,
    skillPlaces,
} from "../src/server/skills.ts";

function skill(folder: string, name: string, description = `The ${name} skill.`): void {
    mkdirSync(join(folder, name), { recursive: true });
    writeFileSync(
        join(folder, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\nThe steps of ${name}.\n`,
    );
}

/**
 * A git repository whose session folder is `repo/app`, and a home folder above it. Skills in the project's folder, in
 * the repository's, above the repository (never read), and in the three places a session no longer looks: `.agents`,
 * Pi's folder, and a folder Pi's settings name.
 */
function fixture() {
    const base = realpathSync(mkdtempSync(join(root, "skills-")));
    const home = join(base, "home");
    const agentDir = join(home, ".pi-pocket", "agent");
    const outside = join(home, "code");
    const repo = join(outside, "repo");
    const cwd = join(repo, "app");

    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(cwd, { recursive: true });
    skill(join(cwd, ".pi-pocket", "skills"), "here");
    skill(join(repo, ".pi-pocket", "skills"), "repo-wide");
    skill(join(outside, ".pi-pocket", "skills"), "outside");
    skill(join(cwd, ".agents", "skills"), "agents-here");
    skill(join(agentDir, "skills"), "pi-user");
    skill(join(base, "extra"), "from-settings");

    const sources: SkillSources = { agentDir, defaultProjectTrust: "ask" };

    return { base, agentDir, repo, cwd, sources };
}

const names = (cwd: string, sources: SkillSources) =>
    loadSessionSkills(cwd, sources)
        .map((each) => each.name)
        .sort();

/** Pi's answer for the fixture's repository: trusted, so its skills load. */
const trusting = (agentDir: string, repo: string) =>
    new ProjectTrustStore(agentDir).set(repo, true);

after(() => {
    cleanUp();
});

test("a project's skills come from its own folder and the folders above it, up to the repository's root", () => {
    const { agentDir, repo, cwd, sources } = fixture();

    trusting(agentDir, repo);
    assert.deepEqual(skillPlaces(cwd, sources), [
        join(cwd, ".pi-pocket", "skills"),
        join(repo, ".pi-pocket", "skills"),
    ]);
    assert.deepEqual(names(cwd, sources), ["here", "repo-wide"]);
    // Above the repository, a folder is not the project's: its skills stay out.
    assert.ok(!names(cwd, sources).includes("outside"));
});

test("no skills come from .agents, Pi's folder, or Pi's settings", () => {
    const { agentDir, repo, cwd, sources } = fixture();

    trusting(agentDir, repo);

    assert.deepEqual(
        names(cwd, sources).filter((name) =>
            ["agents-here", "pi-user", "from-settings"].includes(name),
        ),
        [],
    );
});

test("the nearest folder of a name wins", () => {
    const { agentDir, repo, cwd, sources } = fixture();

    trusting(agentDir, repo);
    skill(join(repo, ".pi-pocket", "skills"), "here", "The repository's own here.");

    assert.deepEqual(names(cwd, sources), ["here", "repo-wide"]);
    assert.equal(
        readFileSync(join(cwd, ".pi-pocket", "skills", "here", "SKILL.md"), "utf8").includes(
            "repository's own",
        ),
        false,
        "the session's folder still wins",
    );
});

test("a project offers no skills until Pi is told to trust it", () => {
    const { agentDir, repo, cwd, sources } = fixture();

    // No decision: nothing loads, and nothing is asked of Pi's own setting here.
    assert.deepEqual(names(cwd, sources), []);
    assert.deepEqual(names(cwd, { ...sources, defaultProjectTrust: "always" }), [
        "here",
        "repo-wide",
    ]);
    assert.deepEqual(names(cwd, { ...sources, defaultProjectTrust: "never" }), []);

    // A saved no for the repository counts for the folder in it.
    new ProjectTrustStore(agentDir).set(repo, false);
    assert.deepEqual(names(cwd, sources), []);

    // A saved yes is the one thing that loads them, and the nearest saved answer wins.
    trusting(agentDir, repo);
    assert.deepEqual(names(cwd, sources), ["here", "repo-wide"]);
    new ProjectTrustStore(agentDir).set(cwd, false);
    assert.deepEqual(names(cwd, { ...sources, defaultProjectTrust: "always" }), []);
});

test("an answer saved with saveProjectTrust decides the skills, and the prompts too", () => {
    const { agentDir, cwd, repo, sources } = fixture();

    saveProjectTrust(cwd, agentDir, "distrust");
    assert.deepEqual(names(cwd, sources), []);
    assert.equal(projectDistrusted(cwd, sources), false, "a project without prompts asks nothing");

    mkdirSync(join(cwd, ".pi-pocket", "prompts"), { recursive: true });
    assert.equal(projectDistrusted(cwd, sources), true);

    saveProjectTrust(cwd, agentDir, "trust");
    assert.deepEqual(names(cwd, sources), ["here", "repo-wide"]);
    assert.equal(projectDistrusted(cwd, sources), false);

    // A decision above the folder counts for the folders in it.
    saveProjectTrust(cwd, agentDir, "trust-parent");
    assert.equal(readProjectTrust(cwd, sources).saved?.path, repo);
});

test("readProjectTrust reports the folders nearest first, and the skills in them", () => {
    const { agentDir, cwd, repo, sources } = fixture();

    new ProjectTrustStore(agentDir).set(repo, true);
    const trust = readProjectTrust(cwd, sources);

    assert.deepEqual(trust.folders, [
        join(cwd, ".pi-pocket", "skills"),
        join(repo, ".pi-pocket", "skills"),
    ]);
    assert.deepEqual(trust.skills.map((each) => each.name).sort(), ["here", "repo-wide"]);
    assert.deepEqual(
        trust.ownSkills.map((each) => each.name),
        ["here"],
    );
    assert.equal(trust.trusted, true);
    assert.equal(trust.settings, false);
});

test("the walk stops at the repository's root, and outside a repository at the folder itself", () => {
    const { agentDir, base, repo, sources } = fixture();

    trusting(agentDir, repo);
    // Above the repository: not the project's. Below it, without one: only the folder itself.
    const loose = join(base, "loose", "inner");

    mkdirSync(loose, { recursive: true });
    skill(join(base, "loose", ".pi-pocket", "skills"), "above-it");
    skill(join(loose, ".pi-pocket", "skills"), "its-own");
    new ProjectTrustStore(agentDir).set(loose, true);
    assert.deepEqual(skillPlaces(loose, sources), [join(loose, ".pi-pocket", "skills")]);
    assert.deepEqual(names(loose, sources), ["its-own"]);
});

test("a skill linked into two folders is listed once", () => {
    const { agentDir, repo, cwd, sources } = fixture();

    trusting(agentDir, repo);

    const shared = join(repo, "shared-skills", "linked");

    mkdirSync(shared, { recursive: true });
    writeFileSync(
        join(shared, "SKILL.md"),
        "---\nname: linked\ndescription: One folder, two names.\n---\nSteps.\n",
    );
    symlinkSync(shared, join(cwd, ".pi-pocket", "skills", "linked"));
    symlinkSync(shared, join(repo, ".pi-pocket", "skills", "linked"));

    assert.equal(names(cwd, sources).filter((name) => name === "linked").length, 1);
});
