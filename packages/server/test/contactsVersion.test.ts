import assert from "node:assert/strict";
import test from "node:test";

import { ContactsVersion } from "../src/server/api/lib/contactsVersion";

// The app downloaded every contact photo (4.2 MB, 0.5-0.8 s of server time) on
// each refresh. It now downloads them only when this version differs from the
// one its saved photos came from.
const db = { count: 0, lastUpdated: null };

test("stays the same while nothing changes", () => {
    const v = new ContactsVersion(1);
    assert.equal(v.of(db), v.of(db));
});

test("changes when macOS reports a change to Contacts", () => {
    const v = new ContactsVersion(1);
    const before = v.of(db);
    v.markChanged();
    assert.notEqual(v.of(db), before);
});

test("changes when the server's own contacts change", () => {
    const v = new ContactsVersion(1);
    assert.notEqual(v.of({ count: 1, lastUpdated: "2026-11-12 10:00:00" }), v.of(db));
    assert.notEqual(
        v.of({ count: 1, lastUpdated: "2026-11-12 10:00:01" }),
        v.of({ count: 1, lastUpdated: "2026-11-12 10:00:00" })
    );
});

test("changes when the server restarts, since a change may have been missed while it was down", () => {
    assert.notEqual(new ContactsVersion(1).of(db), new ContactsVersion(2).of(db));
});
