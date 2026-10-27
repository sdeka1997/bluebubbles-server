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

test("Messages preloads ChatKit before its helper", () => {
    assert.deepEqual(messagesInjectedLibraries("/tmp/BlueBubblesHelper.dylib"), [
        "/System/iOSSupport/System/Library/PrivateFrameworks/ChatKit.framework/ChatKit",
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
            "/System/iOSSupport/System/Library/PrivateFrameworks/ChatKit.framework/ChatKit",
            "/tmp/BlueBubblesHelper.dylib"
        ]),
        "/System/iOSSupport/System/Library/PrivateFrameworks/ChatKit.framework/ChatKit:/tmp/BlueBubblesHelper.dylib"
    );
});
