import assert from "node:assert/strict";
import test from "node:test";

import {
    defaultInjectedLibraries,
    injectedLibrariesEnvironmentValue,
    messagesInjectedLibraries
} from "../src/server/api/privateApi/modes/dylibPlugins/injectedLibraries";

test("dylib plugins inject only their helper by default", () => {
    assert.deepEqual(defaultInjectedLibraries("/tmp/TestHelper.dylib"), ["/tmp/TestHelper.dylib"]);
});

test("Messages injects only its ChatKit-independent helper", () => {
    assert.deepEqual(messagesInjectedLibraries("/tmp/BlueBubblesHelper.dylib"), [
        "/tmp/BlueBubblesHelper.dylib"
    ]);
});

test("FaceTime remains helper-only", () => {
    assert.deepEqual(defaultInjectedLibraries("/tmp/BlueBubblesFaceTimeHelper.dylib"), [
        "/tmp/BlueBubblesFaceTimeHelper.dylib"
    ]);
});

test("DYLD_INSERT_LIBRARIES preserves preload order", () => {
    assert.equal(
        injectedLibrariesEnvironmentValue([
            "/tmp/BlueBubblesHelper.dylib"
        ]),
        "/tmp/BlueBubblesHelper.dylib"
    );
});
