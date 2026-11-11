/**
 * Herdr Core's terminals for PiP: one tool, `hc_tools`, that lists, reads, starts, and steers the agents `hc` runs in
 * terminals that stay alive, on this machine or another. Only PiP's conversation runs it (`PIP_EXTENSIONS`), and a
 * session's default extensions leave it out (`app.ts`). `hc` is called directly, never through a shell, and `run`
 * starts agents alone, so nothing it starts reads what a task says as syntax.
 */
import { spawn } from "node:child_process";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { quoted } from "../fence.ts";
import type { PocketHost } from "../host.ts";

/** The extension's name: PiP selects it by it, and a session's default list leaves it out. */
export const HC_EXTENSION = "pocket-hc";

/** What `hc` answered: its exit code, its output, and the words of a failure. */
export type HcResult = { code: number; stdout: string; stderr: string };

/** Runs `hc`: `argv[0]` is `hc` itself, and each other item is one argument. */
export type Runner = (argv: string[]) => Promise<HcResult>;

/** What `hc_tools` takes, in the order its documentation gives them. */
const TOOLS = ["list", "read", "run", "send", "wait", "kill", "label", "rm", "machines"] as const;

type ToolName = (typeof TOOLS)[number];

/** The agents `run` starts: an interactive agent, never a shell that would read a task as syntax. */
const COMMANDS = ["pi", "claude", "codex", "opencode"] as const;

/** What a shell reads as syntax: refused in a command or a task, since no shell runs it. */
const SHELL = /[;|&<>`]|\$\(/;

/** The most lines `read` asks for, and the lines it asks for when it names none. */
const MAX_LINES = 2000;
const LINES = 200;

/** The seconds `wait` allows when it names none: `hc`'s own default. */
const WAIT_SECONDS = 180;

/**
 * What `hc_tools` answers with when it names no tool: each tool with its arguments, the rules for agents it starts, and
 * what `wait`'s three reasons mean. The six rules are PiP's standing words to whoever runs `hc` here.
 */
const DOCUMENTATION = `Terminals of \`hc\`, which stay alive: start agents, read them, and talk to them. Call hc_tools again with a tool and its args.

- list: every live terminal, as hc lists it. No arguments.
- read: a terminal's screen and its last lines. args: name, lines (default ${String(LINES)}, at most ${String(MAX_LINES)}).
- run: start an agent in the background, labelled owner=pi. args: name, cwd, command (one of ${COMMANDS.join(", ")}), task (the first task; a list of words stays separate words), on (a machine from machines, optional).
- send: type text into a terminal and press enter. args: name, text.
- wait: wait until a terminal stops working. args: name, timeout (seconds); with no name, it waits for all its children. Its reason says what it came to: message (the message is the result, and read cannot fetch it), timeout (only a check that it is still working), or not_started.
- kill: end a terminal labelled owner=pi. args: name.
- label: set a label on a terminal. args: name, label (k=v).
- rm: remove a finished terminal. args: name.
- machines: the machines hc runs on, with their names. No arguments.

Rules:
Always use --bg for agents: without it, their whole screen streams into your output.
Run agents interactively, never pi -p or another one-shot print mode.
Put the first task in run: a send to a booting agent can be dropped.
Do not let children start more agents unless you explicitly assign that.
Never sleep or poll to wait for anything hc runs: use hc wait.
Ask children to write long answers to a file and send its path.`;

/** Whether `value` is a plain object, whose fields a call names. */
const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

/** Run `hc` itself: no shell, each argument its own word, and its stderr kept for a failure. */
const runHc: Runner = (argv) =>
    new Promise((done, fail) => {
        const child = spawn(argv[0]!, argv.slice(1), {
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
        child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
        child.on("error", fail);
        child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    });

/** `hc`'s JSON, as it wrote it; undefined when it wrote something else. */
function jsonOf(result: HcResult): unknown {
    try {
        return JSON.parse(result.stdout) as unknown;
    } catch {
        return undefined;
    }
}

/** The entries of an `hc --json` answer: its list under `key`, or the answer itself when it is a list. */
function listed(found: unknown, key: string): unknown[] {
    if (Array.isArray(found)) {
        return found;
    }

    return isObject(found) && Array.isArray(found[key]) ? (found[key] as unknown[]) : [];
}

/** A call's text argument, trimmed; a missing one is an error that says what the tool needs. */
function needed(args: Record<string, unknown>, key: string, tool: ToolName): string {
    const value = args[key];

    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`hc_tools ${tool} needs ${key}: text.`);
    }

    return value.trim();
}

/** A call's text argument as it came, spaces and all, for text typed into a terminal. */
function typed(args: Record<string, unknown>, key: string, tool: ToolName): string {
    const value = args[key];

    if (typeof value !== "string" || value === "") {
        throw new Error(`hc_tools ${tool} needs ${key}: text.`);
    }

    return value;
}

/** A note about a word `hc` would run: no shell is there to read syntax, so a sign of it is refused. */
function checkNoShell(value: string): void {
    if (SHELL.test(value)) {
        throw new Error(
            `hc_tools runs no shell: ${quoted(value)} holds shell syntax (; | & > < $( or a backtick).`,
        );
    }
}

/** The words of `run`'s first task: one word as it came, or a list of words, each its own argument. */
function words(args: Record<string, unknown>, tool: ToolName): string[] {
    const value = args.task;

    if (typeof value === "string" && value !== "") {
        return [value];
    }

    if (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((each) => typeof each === "string")
    ) {
        return value as string[];
    }

    throw new Error(`hc_tools ${tool} needs task: the first task, as text or a list of words.`);
}

/** The machines `hc machine ls --json` names, in its order. */
async function machines(run: Runner): Promise<string[]> {
    const found = jsonOf(await run(["hc", "machine", "ls", "--json"]));

    return listed(found, "machines").flatMap((each) =>
        typeof each === "string"
            ? [each]
            : isObject(each) && typeof each.name === "string"
              ? [each.name]
              : [],
    );
}

/** Whether a terminal `name` carries the `owner=pi` label: `hc ls --label owner=pi` says which do. */
async function ownedByPi(run: Runner, name: string): Promise<boolean> {
    const found = jsonOf(await run(["hc", "ls", "--json", "--label", "owner=pi"]));

    return listed(found, "terminals").some(
        (each) => isObject(each) && (each.name === name || each.address === name),
    );
}

/** The `hc` arguments a tool call makes, after every check its safety needs; throws for a call it must not make. */
async function argvOf(
    tool: ToolName,
    args: Record<string, unknown>,
    run: Runner,
): Promise<string[]> {
    switch (tool) {
        case "list":
            return ["hc", "ls", "--json"];

        case "read": {
            const name = needed(args, "name", tool);
            const asked = Number(args.lines ?? LINES);
            const lines = Number.isFinite(asked)
                ? Math.min(Math.max(Math.round(asked), 1), MAX_LINES)
                : LINES;

            return ["hc", "read", name, "--json", "--lines", String(lines)];
        }

        case "run": {
            const name = needed(args, "name", tool);
            const cwd = needed(args, "cwd", tool);
            const command = needed(args, "command", tool);
            const task = words(args, tool);

            if (!(COMMANDS as readonly string[]).includes(command)) {
                throw new Error(
                    `hc_tools run starts ${COMMANDS.join(", ")}, not ${quoted(command)}: it starts agents only.`,
                );
            }

            checkNoShell(command);
            task.forEach(checkNoShell);

            const on =
                typeof args.on === "string" && args.on.trim() !== "" ? args.on.trim() : undefined;

            if (on !== undefined) {
                const known = await machines(run);

                if (!known.includes(on)) {
                    throw new Error(
                        `hc_tools run takes a machine hc knows: ${known.length === 0 ? "none is added yet" : known.join(", ")}. ${quoted(on)} is not one.`,
                    );
                }
            }

            return [
                "hc",
                "run",
                "--bg",
                "--name",
                name,
                "--cwd",
                cwd,
                ...(on === undefined ? [] : ["--on", on]),
                "--label",
                "owner=pi",
                "--",
                command,
                ...task,
            ];
        }

        case "send":
            return ["hc", "send", needed(args, "name", tool), typed(args, "text", tool)];

        case "wait": {
            const name =
                typeof args.name === "string" && args.name.trim() !== ""
                    ? args.name.trim()
                    : undefined;
            const asked = Number(args.timeout ?? WAIT_SECONDS);
            const timeout = Number.isFinite(asked) ? Math.max(Math.round(asked), 1) : WAIT_SECONDS;

            return [
                "hc",
                "wait",
                ...(name === undefined ? ["--children", "all"] : [name]),
                "--json",
                "--timeout",
                String(timeout),
            ];
        }

        case "kill": {
            const name = needed(args, "name", tool);

            if (!(await ownedByPi(run, name))) {
                throw new Error(
                    `hc_tools kills only terminals it started, labelled owner=pi: ${quoted(name)} is not one.`,
                );
            }

            return ["hc", "kill", name];
        }

        case "label": {
            const name = needed(args, "name", tool);
            const label = needed(args, "label", tool);

            if (!label.includes("=")) {
                throw new Error("hc_tools label takes label as k=v, such as owner=pi.");
            }

            return ["hc", "label", name, label];
        }

        case "rm":
            return ["hc", "rm", needed(args, "name", tool)];

        case "machines":
            return ["hc", "machine", "ls", "--json"];
    }
}

/** The extension as PiP runs it: `hc_tools`, over `run` (its own `hc` unless a test gives another). */
export function hcExtension(run: Runner = runHc) {
    const reply = (text: string) => ({ output: [{ type: "text" as const, text }] });

    const hcTools = defineTool({
        name: "hc_tools",
        description:
            "Run and steer hc terminals, which stay alive: start agents, read them, and talk to them. Call it with a tool name for that, or with none for what each tool does and the rules for agents you start.",
        parameters: obj(
            {
                tool: opt(
                    str({
                        description: `One of ${TOOLS.join(", ")}; left out, it returns the documentation`,
                    }),
                ),
                args: opt(
                    obj(
                        {},
                        {
                            open: true,
                            description:
                                "The tool's own arguments, as its documentation names them",
                        },
                    ),
                ),
            },
            { open: true },
        ),
        // Not safe to run again: a run starts a terminal, and a send types into one.
        replay: "unsafe",
        execute: async (args) => {
            const wanted = args.tool;

            if (wanted === undefined) {
                return reply(DOCUMENTATION);
            }

            if (!(TOOLS as readonly string[]).includes(wanted)) {
                throw new Error(
                    `hc_tools takes ${TOOLS.join(", ")}, not ${quoted(String(wanted))}. Call it with no tool for what each does.`,
                );
            }

            const tool = wanted as ToolName;
            const own = isObject(args.args) ? args.args : {};
            const argv = await argvOf(tool, own, run);
            const result = await run(argv);
            const body = result.stdout.trim() || result.stderr.trim();

            if (result.code !== 0) {
                throw new Error(
                    `hc ${tool} exited with ${String(result.code)}: ${body === "" ? "(no output)" : body}`,
                );
            }

            return reply(body === "" ? "(no output)" : body);
        },
    });

    return defineExtension({ name: HC_EXTENSION, tools: [hcTools] });
}

/**
 * The extension as Pi Pocket loads it: it starts no `hc` until a tool call does, and it adds nothing to the browser.
 */
export default function createHc(host: PocketHost) {
    void host;

    return hcExtension();
}
