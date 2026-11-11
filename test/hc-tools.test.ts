// PiP's `hc_tools`: what it documents, the `hc` arguments each tool makes, and the calls it refuses (an agent it does
// not start, shell syntax in a task, a terminal it did not start, a tool name it does not have).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { hcExtension, type HcResult } from "../src/server/extensions/hc.ts";

/** Every argv the fake `hc` was given, oldest first. */
let seen: string[][] = [];

/** A fake `hc`: records each call, and answers with what `answer` gives as JSON. */
function fake(answer: (argv: string[]) => unknown = () => ({})) {
    return async (argv: string[]): Promise<HcResult> => {
        seen.push(argv);

        return { code: 0, stdout: JSON.stringify(answer(argv)), stderr: "" };
    };
}

/** `hc_tools`, over a fake `hc`. */
function tool(answer?: (argv: string[]) => unknown): ToolRegistration {
    const found = hcExtension(fake(answer)).tools?.find((each) => each.name === "hc_tools");

    assert.ok(found, "the extension has hc_tools");

    return found;
}

/** What a call answers, as text. */
async function call(over: ToolRegistration, args: unknown): Promise<string> {
    const result = (await over.execute!(args as never, {} as never, {} as never)) as {
        output: { type: string; text?: string }[];
    };

    return result.output
        .flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
        .join("");
}

/** The rules, as PiP must read them, word for word. */
const RULES = [
    "Always use --bg for agents: without it, their whole screen streams into your output.",
    "Run agents interactively, never pi -p or another one-shot print mode.",
    "Put the first task in run: a send to a booting agent can be dropped.",
    "Do not let children start more agents unless you explicitly assign that.",
    "Never sleep or poll to wait for anything hc runs: use hc wait.",
    "Ask children to write long answers to a file and send its path.",
];

test("with no tool, it says what each of the nine does, and the rules to follow", async () => {
    const text = await call(tool(), {});

    for (const name of ["list", "read", "run", "send", "wait", "kill", "label", "rm", "machines"]) {
        assert.match(text, new RegExp(`^- ${name}:`, "m"), `${name} is documented`);
    }

    for (const rule of RULES) {
        assert.ok(text.includes(rule), `the rule is there: ${rule}`);
    }

    // What wait's three reasons mean, in one sentence.
    assert.match(text, /message \(the message is the result, and read cannot fetch it\)/);
    assert.match(text, /timeout \(only a check that it is still working\)/);
    assert.match(text, /not_started/);
    assert.deepEqual(seen, [], "no hc ran for the documentation");
});

test("run starts an agent in the background, labelled owner=pi", async () => {
    seen = [];

    await call(tool(), {
        tool: "run",
        args: { name: "b1", cwd: "/tmp/x", command: "pi", task: "do it" },
    });

    assert.deepEqual(seen, [
        [
            "hc",
            "run",
            "--bg",
            "--name",
            "b1",
            "--cwd",
            "/tmp/x",
            "--label",
            "owner=pi",
            "--",
            "pi",
            "do it",
        ],
    ]);
});

test("a task given as words stays separate arguments, and --on is checked first", async () => {
    seen = [];

    const over = tool((argv) => (argv[1] === "machine" ? { machines: [{ name: "vps" }] } : {}));

    await call(over, {
        tool: "run",
        args: { name: "b2", cwd: "/tmp/y", command: "claude", task: ["read", "src/x"], on: "vps" },
    });

    assert.deepEqual(seen[0], ["hc", "machine", "ls", "--json"]);
    assert.deepEqual(seen[1], [
        "hc",
        "run",
        "--bg",
        "--name",
        "b2",
        "--cwd",
        "/tmp/y",
        "--on",
        "vps",
        "--label",
        "owner=pi",
        "--",
        "claude",
        "read",
        "src/x",
    ]);
    await assert.rejects(
        call(over, {
            tool: "run",
            args: { name: "b3", cwd: "/tmp/y", command: "pi", task: "x", on: "nope" },
        }),
        /takes a machine hc knows: vps/,
    );
});

test("run starts an agent it knows, and no other program", async () => {
    await assert.rejects(
        call(tool(), {
            tool: "run",
            args: { name: "b1", cwd: "/tmp/x", command: "bash", task: "x" },
        }),
        /starts pi, claude, codex, opencode, not “bash”/,
    );
});

test("a command or task holding shell syntax is refused", async () => {
    for (const task of ["do it; rm -rf /", "do it | tee out", "echo $(whoami)", "echo `id`"]) {
        await assert.rejects(
            call(tool(), {
                tool: "run",
                args: { name: "b1", cwd: "/tmp/x", command: "pi", task },
            }),
            /runs no shell/,
            task,
        );
    }
});

test("kill ends only a terminal labelled owner=pi", async () => {
    const mine = tool(() => ({ terminals: [{ address: "t9", name: "b1" }] }));

    seen = [];
    await call(mine, { tool: "kill", args: { name: "b1" } });

    assert.deepEqual(seen, [
        ["hc", "ls", "--json", "--label", "owner=pi"],
        ["hc", "kill", "b1"],
    ]);
    await assert.rejects(
        call(
            tool(() => ({ terminals: [{ address: "t9", name: "b9" }] })),
            {
                tool: "kill",
                args: { name: "b1" },
            },
        ),
        /kills only terminals it started, labelled owner=pi: “b1” is not one/,
    );
});

test("a tool name it does not have is refused, with the nine it takes", async () => {
    await assert.rejects(
        call(tool(), { tool: "spawn" }),
        /hc_tools takes list, read, run, send, wait, kill, label, rm, machines, not “spawn”/,
    );
});
