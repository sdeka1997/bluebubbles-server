import assert from "node:assert/strict";
import test from "node:test";

import { findMyFriendsMiddleware } from "../src/server/api/http/api/v1/middleware/findMyFriendsGate";

const AUTH = ["metrics", "error", "log", "auth"];

test("GET findmy/friends needs the Private API only before macOS 14.4; authentication always", () => {
    assert.deepEqual(findMyFriendsMiddleware(false, AUTH, "privateApi"), [...AUTH, "privateApi"]);
    assert.deepEqual(findMyFriendsMiddleware(true, AUTH, "privateApi"), AUTH);
});
