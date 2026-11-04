import assert from "node:assert/strict";
import test from "node:test";

import { messagePageOrder, totalFromPage, whereUsesAlias } from "../src/server/databases/imessage/helpers/messagePage";

// SQLite only walks message_idx_date for the page when every ORDER BY term
// runs the same way. TypeORM adds "ROWID ASC" to DESC pages unless the query
// names ROWID itself; on a 700k-message chat.db that turned a 2 ms page into
// a 1.8 s sort that blocked the whole server.
test("a newest-first page breaks date ties newest ROWID first", () => {
    assert.deepEqual(messagePageOrder("message.dateCreated", "DESC"), [
        ["message.dateCreated", "DESC"],
        ["message.ROWID", "DESC"]
    ]);
});

test("an oldest-first page breaks date ties oldest ROWID first", () => {
    assert.deepEqual(messagePageOrder("message.dateCreated", "ASC"), [
        ["message.dateCreated", "ASC"],
        ["message.ROWID", "ASC"]
    ]);
});

test("ordering by ROWID needs no second term", () => {
    assert.deepEqual(messagePageOrder("message.ROWID", "DESC"), [["message.ROWID", "DESC"]]);
});

test("a missing sort is newest first", () => {
    assert.deepEqual(messagePageOrder("message.dateCreated", undefined), [
        ["message.dateCreated", "DESC"],
        ["message.ROWID", "DESC"]
    ]);
});

// The total only needs the optional handle/attachment joins when a filter
// reads them; a LEFT JOIN never removes a message, so the count is the same
// without it, and with=[] counts the message table alone.
test("a filter on the sender needs the handle join to count", () => {
    assert.equal(whereUsesAlias([{ statement: "handle.id = :address", args: { address: "x" } }], "handle"), true);
    assert.equal(whereUsesAlias([{ statement: '"handle"."id" = :address', args: { address: "x" } }], "handle"), true);
});

test("filters on message columns do not need the handle join", () => {
    assert.equal(
        whereUsesAlias(
            [
                { statement: "message.ROWID > :startRowId", args: { startRowId: 1 } },
                { statement: "message.handle_id = :id", args: { id: 3 } },
                { statement: "chandle.id = :p", args: { p: "y" } }
            ],
            "handle"
        ),
        false
    );
    assert.equal(whereUsesAlias([], "attachment"), false);
    assert.equal(whereUsesAlias(undefined, "attachment"), false);
});

// A page shorter than the limit is the end of the results, so it already
// says how many there are; only a full page needs the COUNT query.
test("a short page is the whole remaining result, so it gives the total", () => {
    assert.equal(totalFromPage(0, 200, 37), 37);
    assert.equal(totalFromPage(400, 200, 5), 405);
    assert.equal(totalFromPage(0, 200, 0), 0);
});

test("a full page, or an empty page past the start, needs a count", () => {
    assert.equal(totalFromPage(0, 200, 200), null);
    assert.equal(totalFromPage(1000, 200, 0), null);
    assert.equal(totalFromPage(0, null, 50), null);
});
