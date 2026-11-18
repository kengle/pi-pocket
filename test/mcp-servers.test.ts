// The MCP page's "Add a server": one HTTP server added to the agent folder's mcp.json, with every other entry kept,
// the file written with the owner's own rights only, and nothing left behind when a check or a write fails.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
    addServer,
    editServer,
    loadConfig,
    needsApproval,
    NewServerError,
    removeServer,
    settingsStore,
} from "../src/server/extensions/mcp/config.ts";

after(() => {
    cleanUp();
});

/** A fresh agent folder: what `addServer` is given, holding `mcp.json` when `existing` is set. */
function agentFolder(existing?: string): { agentDir: string; file: string } {
    const agentDir = mkdtempSync(join(root, "mcp-"));
    const file = join(agentDir, "mcp.json");

    if (existing !== undefined) {
        writeFileSync(file, existing);
    }

    return { agentDir, file };
}

/** The status an answer was refused with, and that the file is as it was. */
async function refused(
    agentDir: string,
    input: Record<string, unknown>,
    status: number,
    call: (agentDir: string, input: never) => Promise<void> = addServer,
): Promise<void> {
    await assert.rejects(call(agentDir, input as never), (error: unknown) => {
        assert.ok(error instanceof NewServerError);
        assert.equal(error.status, status);

        return true;
    });
}

test("a server the owner adds is an HTTP entry in mcp.json, 0600, beside the ones there", async () => {
    const { agentDir, file } = agentFolder(
        JSON.stringify({
            mcpServers: { "tencent-docs": { type: "http", url: "https://docs.example/mcp" } },
            other: true,
        }),
    );

    await addServer(agentDir, {
        name: "example",
        url: "https://example.com/mcp",
        description: "Example tools",
        headers: { "X-Key": "abc" },
    });

    const written = JSON.parse(readFileSync(file, "utf8"));

    assert.deepEqual(written.mcpServers.example, {
        type: "http",
        url: "https://example.com/mcp",
        description: "Example tools",
        headers: { "X-Key": "abc" },
    });
    // Every other entry and key stays: what the owner approved before is not touched.
    assert.deepEqual(written.mcpServers["tencent-docs"], {
        type: "http",
        url: "https://docs.example/mcp",
    });
    assert.equal(written.other, true);
    assert.equal(statSync(file).mode & 0o777, 0o600, "only the owner reads it");
    assert.deepEqual(
        readdirSync(agentDir).filter((each) => each.endsWith(".tmp")),
        [],
        "no temporary file is left",
    );

    const loaded = await loadConfig(agentDir);

    assert.deepEqual(loaded.servers.map((server) => server.name).sort(), [
        "example",
        "tencent-docs",
    ]);
    assert.deepEqual(loaded.errors, []);
});

test("the folder is made when it is not there yet, and the first server adds no headers", async () => {
    const { agentDir, file } = agentFolder();

    await addServer(join(agentDir, "agent"), { name: "new-one", url: "http://127.0.0.1:9/mcp" });

    const written = JSON.parse(readFileSync(join(agentDir, "agent", "mcp.json"), "utf8"));

    assert.deepEqual(written.mcpServers["new-one"], {
        type: "http",
        url: "http://127.0.0.1:9/mcp",
    });
    assert.equal(existsSync(file), false, "the file beside the new folder is not written");
});

test("a name, an address, or a header the page refuses changes nothing", async () => {
    const existing = JSON.stringify({
        mcpServers: { "tencent-docs": { url: "https://d.example" } },
    });
    const { agentDir, file } = agentFolder(existing);

    await refused(agentDir, { name: "Bad Name", url: "https://x.example/mcp" }, 400);
    await refused(agentDir, { name: "-lead", url: "https://x.example/mcp" }, 400);
    await refused(agentDir, { name: "ok", url: "ftp://x.example/mcp" }, 400);
    await refused(agentDir, { name: "ok", url: "https://x.example/m cp" }, 400);
    await refused(
        agentDir,
        { name: "ok", url: "https://x.example/mcp", headers: { "X-A": "a\nb" } },
        400,
    );
    await refused(
        agentDir,
        { name: "ok", url: "https://x.example/mcp", headers: { "X\nA": "a" } },
        400,
    );

    // A name already there, or one Pi counts as the same: "-" and "_" are one.
    await refused(agentDir, { name: "tencent-docs", url: "https://x.example/mcp" }, 409);
    await refused(agentDir, { name: "tencent_docs", url: "https://x.example/mcp" }, 409);

    assert.equal(readFileSync(file, "utf8"), existing, "the file is as it was");
});

test("an mcp.json that is not read leaves no change, and no half-written file", async () => {
    const broken = "{ not json";
    const { agentDir, file } = agentFolder(broken);

    await refused(agentDir, { name: "ok", url: "https://x.example/mcp" }, 409);

    assert.equal(readFileSync(file, "utf8"), broken, "the file is as it was");
    assert.deepEqual(
        readdirSync(agentDir).filter((each) => each.endsWith(".tmp")),
        [],
    );

    // An object whose mcpServers is not an object is refused the same way.
    const shape = JSON.stringify({ mcpServers: [] });

    writeFileSync(file, shape);
    await refused(agentDir, { name: "ok", url: "https://x.example/mcp" }, 409);
    assert.equal(readFileSync(file, "utf8"), shape);
});

test("a server deleted goes from mcp.json, and every other entry stays whole", async () => {
    const { agentDir, file } = agentFolder(
        JSON.stringify({
            mcpServers: {
                "tencent-docs": { type: "http", url: "https://docs.example/mcp", timeout: 30 },
                gone: { type: "http", url: "https://gone.example/mcp" },
            },
            other: true,
        }),
    );

    await removeServer(agentDir, "gone");

    const written = JSON.parse(readFileSync(file, "utf8"));

    assert.deepEqual(Object.keys(written.mcpServers), ["tencent-docs"]);
    assert.deepEqual(written.mcpServers["tencent-docs"], {
        type: "http",
        url: "https://docs.example/mcp",
        timeout: 30,
    });
    assert.equal(written.other, true);
    assert.equal(statSync(file).mode & 0o777, 0o600);

    // A name that is not there is the answer, and the file keeps every entry it had.
    const before = readFileSync(file, "utf8");

    await refused(agentDir, { name: "absent" }, 404, (dir, input) =>
        removeServer(dir, (input as { name: string }).name),
    );
    assert.equal(readFileSync(file, "utf8"), before);
});

test("deleting a server forgets its approval and switch, so the same name asks again", async () => {
    const { agentDir } = agentFolder(JSON.stringify({ mcpServers: {} }));

    await addServer(agentDir, { name: "example", url: "https://example.com/mcp" });
    const store = settingsStore(agentDir);

    await store.update((settings) => {
        settings.servers = {
            example: { approved: "abc", parts: {}, planMode: true },
            other: { approved: "def" },
        };
    });

    // The page's delete: the entry, then the state that approved it.
    await removeServer(agentDir, "example");
    await store.update((settings) => {
        const next = { ...settings.servers };

        delete next.example;
        settings.servers = next;
    });

    const settings = await store.read();

    assert.equal(settings.servers.example, undefined, "no approval is left behind");
    assert.deepEqual(settings.servers.other, { approved: "def" }, "another server's state stays");
});

test("a server edited keeps its name, its other keys, and loses its approval when its entry moved", async () => {
    const { agentDir, file } = agentFolder(
        JSON.stringify({
            mcpServers: {
                example: {
                    type: "http",
                    url: "https://example.com/mcp",
                    description: "Before",
                    timeout: 20,
                },
            },
        }),
    );

    await editServer(agentDir, "example", {
        url: "https://other.example/mcp",
        description: "After",
        headers: { "X-Key": "abc" },
    });

    const written = JSON.parse(readFileSync(file, "utf8"));

    assert.deepEqual(written.mcpServers.example, {
        type: "http",
        url: "https://other.example/mcp",
        description: "After",
        timeout: 20,
        headers: { "X-Key": "abc" },
    });
    assert.equal(statSync(file).mode & 0o777, 0o600);

    // The fingerprint follows the entry: an approval for the old one no longer covers it.
    const before = (await loadConfig(agentDir)).servers[0]!;

    assert.equal(needsApproval(before, { approved: "an-approval-of-the-entry-before" }), true);
    assert.equal(needsApproval(before, { approved: before.fingerprint }), false);

    // Empty header rows mean none: the ones before go.
    await editServer(agentDir, "example", { url: "https://other.example/mcp", headers: {} });
    assert.equal(
        "headers" in (JSON.parse(readFileSync(file, "utf8")).mcpServers.example as object),
        false,
    );
});

test("an edit refuses a new name, a bad address, a header with a newline, and a name not there", async () => {
    const existing = JSON.stringify({
        mcpServers: { example: { type: "http", url: "https://example.com/mcp" } },
    });
    const { agentDir, file } = agentFolder(existing);

    const denied = async (what: string, input: object, status: number) => {
        await assert.rejects(editServer(agentDir, "example", input as never), (error: unknown) => {
            assert.ok(error instanceof NewServerError, what);
            assert.equal(error.status, status, what);

            return true;
        });
    };

    await denied("a new name", { name: "renamed", url: "https://x.example/mcp" }, 400);
    await denied("a bad address", { url: "ftp://x.example/mcp" }, 400);
    await denied(
        "a header with a newline",
        { url: "https://x.example/mcp", headers: { X: "a\nb" } },
        400,
    );
    assert.equal(readFileSync(file, "utf8"), existing, "the file is as it was");

    await assert.rejects(
        editServer(agentDir, "absent", { url: "https://x.example/mcp" }),
        (error: unknown) => {
            assert.ok(error instanceof NewServerError);
            assert.equal(error.status, 404);

            return true;
        },
    );
});

test("an edit leaves a broken mcp.json alone, and no temporary file", async () => {
    const broken = "{ not json";
    const { agentDir, file } = agentFolder(broken);

    await refused(agentDir, { url: "https://x.example/mcp" }, 409, (dir, input) =>
        editServer(dir, "example", input),
    );
    assert.equal(readFileSync(file, "utf8"), broken);
    assert.deepEqual(
        readdirSync(agentDir).filter((each) => each.endsWith(".tmp")),
        [],
    );
});
