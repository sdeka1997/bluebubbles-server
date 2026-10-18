import assert from "node:assert/strict";
import test from "node:test";

import { AddExternalIdToContacts1750299580000 } from "../src/server/databases/server/migrations/1750299580000-AddExternalIdToContacts";
// eslint-disable-next-line max-len
import { RecoverableDeleteReceiptTable1760659200000 } from "../src/server/databases/server/migrations/1760659200000-RecoverableDeleteReceiptTable";

test("contact external-id migration exposes a stable timestamped TypeORM name", () => {
    const migration = new AddExternalIdToContacts1750299580000();

    assert.equal(migration.name, "AddExternalIdToContacts1750299580000");
    assert.match(migration.name, /\d{13}$/);
});

test("recoverable-delete receipt migration exposes a stable timestamped TypeORM name", () => {
    const migration = new RecoverableDeleteReceiptTable1760659200000();

    assert.equal(migration.name, "RecoverableDeleteReceiptTable1760659200000");
    assert.match(migration.name, /\d{13}$/);
});
