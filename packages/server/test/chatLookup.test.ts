import assert from "node:assert/strict";
import test from "node:test";

import { withChatLookup } from "../src/server/api/privateApi/chatLookup";

const payload = { chatGuid: "iMessage;-;+15550001111", message: "hi", partIndex: 0 };

test("old clients send exactly the same helper payload", () => {
    assert.deepEqual(withChatLookup(payload, undefined), payload);
    assert.deepEqual(withChatLookup(payload, null), payload);
    assert.deepEqual(withChatLookup(payload, {}), payload);
});

test("group id, participants and service are passed through to the helper", () => {
    assert.deepEqual(
        withChatLookup(payload, {
            groupId: "4F2C1D7E-0000-4000-8000-000000000001",
            participants: ["+15550001111"],
            service: "iMessage"
        }),
        {
            ...payload,
            groupId: "4F2C1D7E-0000-4000-8000-000000000001",
            participants: ["+15550001111"],
            service: "iMessage"
        }
    );
});

test("a single form-data participant becomes a one-item list", () => {
    assert.deepEqual(withChatLookup(payload, { participants: "+15550001111" }), {
        ...payload,
        participants: ["+15550001111"]
    });
});

test("empty or malformed lookup values are dropped", () => {
    assert.deepEqual(
        withChatLookup(payload, { groupId: "", participants: ["", 7, null] as any, service: 1 as any }),
        payload
    );
});

test("lookup values never override the chat guid", () => {
    assert.equal(withChatLookup(payload, { chatGuid: "other" } as any).chatGuid, payload.chatGuid);
});
