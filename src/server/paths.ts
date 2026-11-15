/** Paths as people write them (`~/project`) and as activity lines show them, and where Pi and a project keep theirs. */
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { dataDir } from "./config.ts";

/** Pi's folder for this process: `PI_CODING_AGENT_DIR`, else `<data>/agent` (`main.ts` sets it before any read). */
export function agentDir(): string {
    const named = process.env.PI_CODING_AGENT_DIR;

    return named === undefined || named.trim() === ""
        ? join(dataDir(), "agent")
        : expandHome(named.trim());
}

/** The folder a project keeps Pi Pocket's files in: `.pi-pocket`, never Pi's own `.pi`. */
export function projectDirName(): string {
    return ".pi-pocket";
}

/** The project's own folder for Pi: `<cwd>/.pi`. */
export function projectDir(cwd: string): string {
    return join(cwd, projectDirName());
}

/** The project's skills: `<cwd>/.pi/skills`. */
export function skillsSubdir(cwd: string): string {
    return join(projectDir(cwd), "skills");
}

/** The project's prompt templates: `<cwd>/.pi/prompts`. */
export function promptsSubdir(cwd: string): string {
    return join(projectDir(cwd), "prompts");
}

/** A project's own Pi settings: `<cwd>/.pi/settings.json`. */
export function projectSettingsFile(cwd: string): string {
    return join(projectDir(cwd), "settings.json");
}

/** Pi's skills for every project: `<agentDir>/skills`. */
export function userSkillsDir(agent: string): string {
    return join(agent, "skills");
}

/** The home folder's skills, for every project: `~/.agents/skills`. */
export function homeSkillsDir(home: string): string {
    return join(home, ".agents", "skills");
}

/** The project's design system: `<cwd>/.pi-pocket/design`. */
export function designDir(cwd: string): string {
    return join(projectDir(cwd), "design");
}

/** Pi's MCP servers, as Pi's own app reads them: `<agentDir>/mcp.json`. */
export function mcpConfigPath(): string {
    return join(agentDir(), "mcp.json");
}

/** Pi's trust store: `<agentDir>/trust.json`. */
export function trustFile(): string {
    return join(agentDir(), "trust.json");
}

/** Lancet Guard's settings, in the data folder: `<data>/lancet-guard.json`, copied once from Pi's `~/.pi`. */
export function lancetFile(): string {
    return join(dataDir(), "lancet-guard.json");
}

/** `~` and `~/x` to absolute paths; anything else unchanged. */
export function expandHome(path: string): string {
    if (path === "~") {
        return homedir();
    }

    if (path.startsWith("~/")) {
        return join(homedir(), path.slice(2));
    }

    return path;
}

/** `~/x` for paths under home. */
export function homePath(path: string): string {
    const home = homedir();

    return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** A path as people read it in a session: relative to its folder when inside it, else `~/x` or absolute. */
export function displayPath(path: string, cwd: string): string {
    return path.startsWith(cwd + sep) ? relative(cwd, path) : homePath(path);
}

/**
 * The scheme of a workspace URI (`ssh://host/path`), lower case, or undefined for a local path.
 * It needs 2 characters or more and `://`, so a Windows drive (`C:\work`, `D:`) stays a path.
 */
export function workspaceScheme(cwd: string): string | undefined {
    return /^([a-z][a-z0-9+.-]+):\/\//i.exec(cwd)?.[1]?.toLowerCase();
}
