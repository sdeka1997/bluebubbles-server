import assert from "node:assert/strict";
import test from "node:test";

import {
    FIND_MY_LIVE_HANDLE_LIMIT,
    FindMyLiveTrackingInputError,
    FindMyLiveTrackingNotFound,
    findMyLiveTrackingFailureStatus,
    findMyLiveTrackingHandle
} from "../src/server/api/lib/findmy/FindMyLiveTrackingRequest";

test("accepts exactly a string Apple handle or explicit null", () => {
    assert.equal(findMyLiveTrackingHandle({ handle: " friend@example.com " }), " friend@example.com ");
    assert.equal(findMyLiveTrackingHandle({ handle: null }), null);
    assert.throws(() => findMyLiveTrackingHandle({}), FindMyLiveTrackingInputError);
    assert.throws(() => findMyLiveTrackingHandle({ handle: 7 }), FindMyLiveTrackingInputError);
    assert.throws(() => findMyLiveTrackingHandle("friend@example.com"), FindMyLiveTrackingInputError);
});

test("rejects empty and oversized handles as bad input", () => {
    assert.throws(() => findMyLiveTrackingHandle({ handle: "   " }), FindMyLiveTrackingInputError);
    assert.throws(
        () => findMyLiveTrackingHandle({ handle: "a".repeat(FIND_MY_LIVE_HANDLE_LIMIT + 1) }),
        FindMyLiveTrackingInputError
    );
    assert.equal(findMyLiveTrackingHandle({ handle: "a".repeat(FIND_MY_LIVE_HANDLE_LIMIT) }).length, FIND_MY_LIVE_HANDLE_LIMIT);
});

test("maps bad input to 400, an unknown handle to 404, and anything else to 500", () => {
    assert.equal(findMyLiveTrackingFailureStatus(new FindMyLiveTrackingInputError("bad")), 400);
    assert.equal(findMyLiveTrackingFailureStatus(new FindMyLiveTrackingNotFound()), 404);
    assert.equal(findMyLiveTrackingFailureStatus(new Error("bridge unavailable")), 500);
});
