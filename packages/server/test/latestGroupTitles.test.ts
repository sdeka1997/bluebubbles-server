import assert from "node:assert/strict";
import test from "node:test";

import { latestGroupTitles } from "../src/server/databases/imessage/helpers/latestGroupTitles";

// node:sqlite ships with Node 22; the repo's @types/node predates it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require("node:sqlite");
type DatabaseSync = any;

// Minimal chat.db shape: a rename is a message with item_type 2 and the new
// name in group_title (null when the name was cleared).
function db() {
    const d = new DatabaseSync(":memory:");
    d.exec(`
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, item_type INTEGER, group_title TEXT, date INTEGER);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    `);
    return d;
}

function add(d: DatabaseSync, rowid: number, chat: number, itemType: number, title: string | null, date: number) {
    d.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(rowid, itemType, title, date);
    d.prepare("INSERT INTO chat_message_join VALUES (?, ?)").run(chat, rowid);
}

const runner = (d: DatabaseSync) => async (sql: string, params: any[]) => d.prepare(sql).all(...params);

test("the newest rename is the chat's name", async () => {
    const d = db();
    add(d, 1, 35, 2, "fam", 100);
    add(d, 2, 35, 2, "family", 200);
    add(d, 3, 35, 0, null, 300);
    assert.deepEqual(await latestGroupTitles(runner(d), [35]), new Map([[35, "family"]]));
});

test("a cleared name is an empty name, not a missing one", async () => {
    const d = db();
    add(d, 1, 2430, 2, "family", 100);
    add(d, 2, 2430, 2, null, 200);
    assert.deepEqual(await latestGroupTitles(runner(d), [2430]), new Map([[2430, ""]]));
});

test("a chat never renamed has no entry", async () => {
    const d = db();
    add(d, 1, 7, 0, null, 100);
    assert.deepEqual(await latestGroupTitles(runner(d), [7]), new Map());
});

test("only the requested chats are read, each on its own", async () => {
    const d = db();
    add(d, 1, 1, 2, "a", 100);
    add(d, 2, 2, 2, "b", 300);
    add(d, 3, 1, 2, "a2", 200);
    add(d, 4, 3, 2, "c", 400);
    assert.deepEqual(await latestGroupTitles(runner(d), [1, 2]), new Map([[1, "a2"], [2, "b"]]));
});

test("renames at the same time resolve to the later row", async () => {
    const d = db();
    add(d, 1, 9, 2, "first", 100);
    add(d, 2, 9, 2, "second", 100);
    assert.deepEqual(await latestGroupTitles(runner(d), [9]), new Map([[9, "second"]]));
});

test("no chats means no query", async () => {
    let called = false;
    const result = await latestGroupTitles(async () => {
        called = true;
        return [];
    }, []);
    assert.equal(called, false);
    assert.deepEqual(result, new Map());
});
