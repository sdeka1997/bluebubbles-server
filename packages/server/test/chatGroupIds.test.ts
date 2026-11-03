import assert from "node:assert/strict";
import test from "node:test";

import { legacyGroupIds } from "../src/server/api/serializers/chatGroupIds";

test("old group ids Messages keeps for a chat are returned", () => {
    assert.deepEqual(
        legacyGroupIds([{ LegacyGroupIdentifiers: ["B6EF9F32-089B-4CC4-9FA3-F44FB3507338", "6B56CF30-0000-4000-8000-000000000001"] }]),
        ["B6EF9F32-089B-4CC4-9FA3-F44FB3507338", "6B56CF30-0000-4000-8000-000000000001"]
    );
});

test("ids from every properties entry are combined without duplicates", () => {
    assert.deepEqual(
        legacyGroupIds([
            { LegacyGroupIdentifiers: ["A", "B"] },
            { LegacyGroupIdentifiers: ["B", "C"] }
        ]),
        ["A", "B", "C"]
    );
});

test("a chat without old group ids has none", () => {
    assert.deepEqual(legacyGroupIds([{ SMSCategory: 0 }]), []);
    assert.deepEqual(legacyGroupIds(null), []);
    assert.deepEqual(legacyGroupIds(undefined), []);
    assert.deepEqual(legacyGroupIds([]), []);
});

test("entries that are not ids are ignored", () => {
    assert.deepEqual(legacyGroupIds([null, "x", { LegacyGroupIdentifiers: "A" }] as any), []);
    assert.deepEqual(legacyGroupIds([{ LegacyGroupIdentifiers: ["A", "", "  ", 3, null] }] as any), ["A"]);
});
