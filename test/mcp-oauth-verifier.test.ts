// A rejected token request must not turn into "No OAuth PKCE code verifier is stored".
import { keepVerifier } from "../src/server/extensions/mcp/oauth.ts";
import assert from "node:assert/strict";
import test from "node:test";

import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";

const pending: McpOAuthState = {
    serverUrl: "https://grist.localhost:8080/mcp",
    codeVerifier: "verifier-1",
    oauthState: "state-1",
};

/** A store that only ever holds what was last saved into it. */
function memoryStore(initial: McpOAuthState) {
    let state: McpOAuthState | undefined = initial;

    return {
        load: () => state,
        save: (next: McpOAuthState) => {
            state = next;
        },
        current: () => state,
    };
}

test("keeps the verifier when the flow wipes all credentials", async () => {
    const store = memoryStore({ ...pending });
    const guarded = keepVerifier(store, pending);

    // What `invalidateCredentials("all")` saves: only what the provider owns, nothing else.
    await guarded.save({ serverUrl: pending.serverUrl });

    assert.equal(store.current()?.codeVerifier, "verifier-1");
    assert.equal(store.current()?.oauthState, "state-1");
});

test("does not bring a finished verifier back", async () => {
    const store = memoryStore({ ...pending });
    const guarded = keepVerifier(store, pending);

    await guarded.save({ serverUrl: pending.serverUrl, tokens: { access_token: "a" } as any });

    // A save that leaves the fields alone keeps them; a save that sets its own wins.
    await guarded.save({ serverUrl: pending.serverUrl, codeVerifier: "verifier-2" });
    assert.equal(store.current()?.codeVerifier, "verifier-2");
});
