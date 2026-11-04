import assert from "node:assert/strict";
import test from "node:test";

import { groupingFieldsForMessages } from "../src/server/api/serializers/chatGroupIds";

// Answers groupingFields' two queries and records every call.
function runner() {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const run = async (sql: string, params: any[]) => {
        calls.push({ sql, params });
        if (sql.includes("original_group_id")) return params.map(id => ({ ROWID: id, original_group_id: `G${id}` }));
        return params.filter(id => id === 2).map(id => ({ chat_id: id, group_title: "renamed" }));
    };
    return { run, calls };
}

const chat = (ROWID: number, style?: number) => ({ ROWID, style, properties: null as any });

test("a page of messages looks up each chat's grouping fields once, not once per message", async () => {
    const { run, calls } = runner();
    const shared = [chat(1), chat(2), chat(3)];
    const messages = Array.from({ length: 200 }, (_, i) => ({ chats: [shared[i % 3]] }));

    const fields = await groupingFieldsForMessages(run, messages);

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].params, [1, 2, 3]);
    assert.deepEqual(calls[1].params, [1, 2, 3]);
    assert.deepEqual(fields.get(1), { originalGroupId: "G1", legacyGroupIds: [], latestGroupTitle: null });
    assert.deepEqual(fields.get(2), { originalGroupId: "G2", legacyGroupIds: [], latestGroupTitle: "renamed" });
});

test("messages without chats need no lookups", async () => {
    const { run, calls } = runner();
    const fields = await groupingFieldsForMessages(run, [{ chats: [] }, { chats: undefined }, {} as any, null as any]);
    assert.equal(fields.size, 0);
    assert.equal(calls.length, 0);
});

// Messages only lets a group be renamed (style 43); on Sequoia chat.db has no
// rename in any one-to-one chat, and scanning a long DM for one is the slow part.
test("one-to-one chats are not searched for renames", async () => {
    const { run, calls } = runner();
    const fields = await groupingFieldsForMessages(run, [{ chats: [chat(1, 45), chat(2, 43)] }, { chats: [chat(3)] }]);

    const titleCall = calls.find(c => !c.sql.includes("original_group_id"));
    assert.deepEqual(titleCall?.params, [2, 3]);
    assert.equal(fields.get(1)?.latestGroupTitle, null);
    assert.equal(fields.get(1)?.originalGroupId, "G1");
    assert.equal(fields.get(2)?.latestGroupTitle, "renamed");
});
