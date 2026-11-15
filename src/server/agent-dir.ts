/**
 * Pi's folder for this process: the data folder's `agent` (`~/.pi-pocket/agent`), unless `PI_CODING_AGENT_DIR` names
 * another. Pi's sign-ins, model choices, settings, and trust store move there once, from `~/.pi/agent`, so the app keeps
 * working as it did; the sessions of Pi's terminal app stay where they are, and the old folder is not touched.
 *
 * This runs before anything reads Pi's folder (`main.ts`, beside `PI_POCKET_DIR`), so every later `agentDir()` and every
 * library call that takes it see the same folder.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { homePath, lancetFile } from "./paths.ts";

/** The files Pi's app keeps that a move carries: its sign-ins and choices, never its sessions. */
const CARRIED = ["auth.json", "models.json", "settings.json", "trust.json"];

/**
 * Where Pi's app keeps its own folder: `~/.pi/agent`, Pi's, not a project's. A literal, because a project's name is
 * `.pi-pocket` now and this is the one folder Pi Pocket reads there.
 */
function piAgentDir(): string {
    return join(homedir(), ".pi", "agent");
}

/**
 * Copy the four files of `from` into `into`, when `into` holds nothing yet: each keeps the permissions it had, and the
 * old files stay as they were. Gives the names copied, and nothing on a second start or with another folder named.
 */
export function carryAgentFiles(from: string, into: string): string[] {
    if (from === into || !existsSync(from)) {
        return [];
    }

    // A folder with anything in it was made before this start: the move is once.
    if (existsSync(into) && readdirSync(into).length > 0) {
        return [];
    }

    mkdirSync(into, { recursive: true, mode: 0o700 });

    const copied: string[] = [];

    for (const name of CARRIED) {
        const source = join(from, name);

        if (!existsSync(source)) {
            continue;
        }

        copyFileSync(source, join(into, name));
        chmodSync(join(into, name), statSync(source).mode & 0o777);
        copied.push(name);
    }

    return copied;
}

/**
 * Carry Lancet Guard's settings from Pi's own folder into the data folder, once: the guard reads one file, and the
 * owner should not have to make it again. The file in `~/.pi` stays as it was.
 */
export function carryLancetFile(): void {
    const into = lancetFile();

    if (existsSync(into)) {
        return;
    }

    const from = join(homedir(), ".pi", "lancet-guard.json");

    if (!existsSync(from)) {
        return;
    }

    copyFileSync(from, into);
    chmodSync(into, statSync(from).mode & 0o777);
    console.log(
        `Lancet Guard's settings copied to ${homePath(into)}; the file in ~/.pi stays as it was.`,
    );
}

/**
 * Give this process Pi's folder at `dataDir()/agent`, unless the owner's environment already named one, and carry the
 * four files over on the first start. One line says what moved, where, and what stayed.
 */
export function usePocketAgentDir(data: string): void {
    const chosen = process.env.PI_CODING_AGENT_DIR || join(data, "agent");

    process.env.PI_CODING_AGENT_DIR = chosen;

    const copied = carryAgentFiles(piAgentDir(), chosen);

    if (copied.length > 0) {
        console.log(
            `Pi's ${copied.join(", ")} copied to ${homePath(chosen)}: the sign-ins and choices of Pi's terminal app, kept once. Its sessions stay in ${homePath(piAgentDir())}.`,
        );
    }
}
