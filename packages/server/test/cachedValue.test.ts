import assert from "node:assert/strict";
import test from "node:test";

import { cachedValue } from "../src/server/helpers/cachedValue";

// server/info asked Apple's time server on every call (0.3-1.1 s each);
// the answer is now reused for a while.
test("reuses the value until it expires", async () => {
    let calls = 0;
    let clock = 0;
    const get = cachedValue(600_000, async () => ++calls, () => clock);
    assert.equal(await get(), 1);
    clock = 599_999;
    assert.equal(await get(), 1);
    clock = 600_000;
    assert.equal(await get(), 2);
});

test("callers that arrive during a fetch share it", async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => (release = resolve));
    const get = cachedValue(1000, async () => {
        calls++;
        await gate;
        return "t";
    });
    const both = Promise.all([get(), get()]);
    release();
    assert.deepEqual(await both, ["t", "t"]);
    assert.equal(calls, 1);
});

test("a failed fetch is tried again next time", async () => {
    let calls = 0;
    const get = cachedValue(1000, async () => {
        if (++calls === 1) throw new Error("offline");
        return 5;
    });
    await assert.rejects(get());
    assert.equal(await get(), 5);
});
