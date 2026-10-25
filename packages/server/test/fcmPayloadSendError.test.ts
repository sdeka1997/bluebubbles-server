import { strict as assert } from "node:assert";
import test from "node:test";

import { boundFcmDataPayload, fcmDataPayloadBytes, FCM_MAX_DATA_BYTES } from "../src/server/services/fcmService/FcmPayload";

const message = (overrides: Record<string, unknown> = {}) => ({
    guid: "m1",
    text: "hello",
    subject: null,
    dateCreated: 1,
    isFromMe: true,
    itemType: 0,
    attachments: [],
    chats: [{ guid: "chat-guid", displayName: "Group", participants: [{ address: "x".repeat(5000) }] }],
    ...overrides
});

test("an oversized message-send-error is compacted like new-message instead of dropped", () => {
    const value = { type: "message-send-error", data: JSON.stringify(message({ error: 22 })) };
    const out = boundFcmDataPayload(value);
    assert.ok(out, "must not be skipped");
    assert.ok(fcmDataPayloadBytes(out!) <= FCM_MAX_DATA_BYTES);
    const decoded = JSON.parse(out!.data);
    assert.equal(decoded.guid, "m1");
    assert.equal(decoded.text, "hello");
    assert.equal(decoded.chats[0].guid, "chat-guid");
});
