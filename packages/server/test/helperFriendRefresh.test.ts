import assert from "node:assert/strict";
import test from "node:test";

import { triggerFriendRefresh } from "../src/server/api/lib/findmy/helperFriendRefresh";

const setup = (helper: { connected: boolean; fails?: boolean }) => {
    const calls: string[] = [];
    const logs: string[] = [];
    const run = () =>
        triggerFriendRefresh(
            {
                connected: () => helper.connected,
                refreshFriends: async () => {
                    calls.push("helper");
                    if (helper.fails) throw new Error("Transaction timeout");
                }
            },
            async () => {
                calls.push("relaunch");
            },
            message => logs.push(message)
        );
    return { calls, logs, run };
};

// The helper runs inside Messages, which may ask Find My's locate service directly, so a
// connected helper should replace the quit-and-relaunch of the Find My app.
test("a connected helper is asked to locate every friend and Find My is not relaunched", async () => {
    const { calls, logs, run } = setup({ connected: true });

    assert.equal(await run(), "helper");
    assert.deepEqual(calls, ["helper"]);
    assert.ok(logs.some(line => line.includes("asked the Private API helper")));
});

test("without a connected helper, Find My is relaunched as before", async () => {
    const { calls, run } = setup({ connected: false });

    assert.equal(await run(), "relaunch");
    assert.deepEqual(calls, ["relaunch"]);
});

test("a failed helper request falls back to relaunching Find My and says so", async () => {
    const { calls, logs, run } = setup({ connected: true, fails: true });

    assert.equal(await run(), "relaunch");
    assert.deepEqual(calls, ["helper", "relaunch"]);
    assert.ok(logs.some(line => line.includes("Transaction timeout")));
});
