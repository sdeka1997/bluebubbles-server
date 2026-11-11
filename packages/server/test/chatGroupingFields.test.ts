import assert from "node:assert/strict";
import test from "node:test";

import { groupingFields, groupingRows } from "../src/server/api/serializers/chatGroupIds";

// Answers the two read-only queries groupingFields makes, from fixed tables.
function runner(original: Record<number, string | null>, renames: Array<[number, string | null]>, failOriginal = false) {
    const calls: string[] = [];
    const run = async (sql: string, params: any[]) => {
        calls.push(sql);
        if (sql.includes("original_group_id")) {
            if (failOriginal) throw new Error("no such column: original_group_id");
            return params.filter(id => id in original).map(id => ({ ROWID: id, original_group_id: original[id] }));
        }
        return renames.filter(([id]) => params.includes(id)).map(([chat_id, group_title]) => ({ chat_id, group_title }));
    };
    return { run, calls };
}

const chat = (ROWID: number, properties: any = null) => ({ ROWID, properties });

test("each chat gets its original group id, old group ids and newest rename", async () => {
    const { run } = runner({ 35: "B6EF9F32", 2440: "2440-ORIG" }, [[35, "family"], [2440, null]]);
    const fields = await groupingFields(run, [
        chat(35, [{ LegacyGroupIdentifiers: ["B6EF9F32", "OLD-1"] }]),
        chat(2440)
    ]);
    assert.deepEqual(fields.get(35), { originalGroupId: "B6EF9F32", legacyGroupIds: ["B6EF9F32", "OLD-1"], latestGroupTitle: "family" });
    assert.deepEqual(fields.get(2440), { originalGroupId: "2440-ORIG", legacyGroupIds: [], latestGroupTitle: "" });
});

test("a chat never renamed has a null newest rename, not an empty name", async () => {
    const { run } = runner({ 7: null }, []);
    const fields = await groupingFields(run, [chat(7)]);
    assert.deepEqual(fields.get(7), { originalGroupId: null, legacyGroupIds: [], latestGroupTitle: null });
});

test("a Mac without original_group_id still gets the other fields", async () => {
    const { run } = runner({}, [[5, "x"]], true);
    const fields = await groupingFields(run, [chat(5, [{ LegacyGroupIdentifiers: ["G"] }])]);
    assert.deepEqual(fields.get(5), { originalGroupId: null, legacyGroupIds: ["G"], latestGroupTitle: "x" });
});

test("a failing query never breaks serialization", async () => {
    const fields = await groupingFields(async () => {
        throw new Error("database is locked");
    }, [chat(1)]);
    assert.deepEqual(fields.get(1), { originalGroupId: null, legacyGroupIds: [], latestGroupTitle: null });
});

test("no chats means no queries", async () => {
    const { run, calls } = runner({}, []);
    assert.equal((await groupingFields(run, [])).size, 0);
    assert.equal(calls.length, 0);
});

test("a grouping row carries exactly what the client groups and spam-files a chat by", async () => {
    const { run } = runner({ 35: "B6EF9F32" }, [[35, "family"]]);
    const rows = await groupingRows(run, [
        { ROWID: 35, style: 43, guid: "iMessage;+;chat1", groupId: "G1", properties: [{ LegacyGroupIdentifiers: ["OLD-1"], SMSCategory: 1 }] },
        { ROWID: 7, style: 45, guid: "SMS;-;+15550001", groupId: null, properties: null }
    ]);
    assert.deepEqual(rows, [
        { guid: "iMessage;+;chat1", groupId: "G1", isFilteredAsSpam: true, originalGroupId: "B6EF9F32", legacyGroupIds: ["OLD-1"], latestGroupTitle: "family" },
        { guid: "SMS;-;+15550001", groupId: null, isFilteredAsSpam: false, originalGroupId: null, legacyGroupIds: [], latestGroupTitle: null }
    ]);
});
