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

after(() => {
    cleanUp();
});

test("a project's skills come from its own folder and the folders above it, up to the repository's root", () => {
    const { repo, cwd, sources } = fixture();

    assert.deepEqual(skillPlaces(cwd, sources), [
        join(cwd, ".pi-pocket", "skills"),
        join(repo, ".pi-pocket", "skills"),
    ]);
    assert.deepEqual(names(cwd, sources), ["here", "repo-wide"]);
    // Above the repository, a folder is not the project's: its skills stay out.
    assert.ok(!names(cwd, sources).includes("outside"));
});

test("no skills come from .agents, Pi's folder, or Pi's settings", () => {
    const { cwd, sources } = fixture();

    assert.deepEqual(
        names(cwd, sources).filter((name) =>
            ["agents-here", "pi-user", "from-settings"].includes(name),
        ),
        [],
    );
});

test("the nearest folder of a name wins", () => {
    const { repo, cwd, sources } = fixture();

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

test("a project Pi was told not to trust offers no skills", () => {
    const { agentDir, repo, cwd, sources } = fixture();

    // A saved no for the repository counts for the folder in it.
    new ProjectTrustStore(agentDir).set(repo, false);
    assert.deepEqual(names(cwd, sources), []);

    // Pi's own setting, where nobody decided: "never" keeps them out too.
    const { cwd: other, sources: asking } = fixture();
    const never: SkillSources = { ...asking, defaultProjectTrust: "never" };

    assert.deepEqual(names(other, never), []);
    // Nobody decided, and Pi's setting asks: Pi Pocket cannot ask here, so the project's skills load.
    assert.deepEqual(names(other, asking), ["here", "repo-wide"]);
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

test("a skill linked into two folders is listed once", () => {
    const { repo, cwd, sources } = fixture();
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
