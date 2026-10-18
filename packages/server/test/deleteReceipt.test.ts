import "reflect-metadata";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DataSource } from "typeorm";

import { RecoverableDeleteReceipt } from "../src/server/databases/server/entity/RecoverableDeleteReceipt";
// eslint-disable-next-line max-len
import { RecoverableDeleteReceiptTable1760659200000 } from "../src/server/databases/server/migrations/1760659200000-RecoverableDeleteReceiptTable";
import {
    DeleteAttemptConflictError,
    RecoverableDeletePreDispatchError,
    RecoverableDeleteReceiptService,
    hashRecoverableDeleteChatGuid,
    isValidRecoverableDeleteAttemptId
} from "../src/server/services/RecoverableDeleteReceiptService";

const CHAT = "iMessage;-;+15555550100";
const OTHER_CHAT = "iMessage;+;chat000000000000000001";

const createReceiptDataSource = (database: string) =>
    new DataSource({
        type: "better-sqlite3",
        database,
        entities: [RecoverableDeleteReceipt],
        migrations: [RecoverableDeleteReceiptTable1760659200000],
        migrationsTableName: "migrations",
        migrationsRun: true,
        synchronize: false
    });

async function withDatabaseFile(run: (database: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), "bb-delete-receipt-"));
    try {
        await run(join(directory, "config.db"));
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function withReceiptDatabase(run: (db: DataSource, database: string) => Promise<void>) {
    await withDatabaseFile(async database => {
        const db = createReceiptDataSource(database);
        try {
            await db.initialize();
            await run(db, database);
        } finally {
            if (db.isInitialized) await db.destroy();
        }
    });
}

const rowFor = async (db: DataSource, attemptId: string) =>
    db.getRepository(RecoverableDeleteReceipt).findOneBy({ attemptId });

const attempt = (label: string) => `attempt_${label}`.padEnd(22, "x");

test("migration creates the constrained receipt table and matches the entity", async () => {
    await withReceiptDatabase(async db => {
        const applied = await db.query(`SELECT name FROM migrations`);
        assert.deepEqual(
            applied.map((row: { name: string }) => row.name),
            ["RecoverableDeleteReceiptTable1760659200000"]
        );

        const table = await db.createQueryRunner().getTable("recoverable_delete_receipt");
        assert.ok(table);
        assert.deepEqual(
            table.primaryColumns.map(column => column.name),
            ["attempt_id"]
        );
        assert.deepEqual(table.columns.map(column => column.name).sort(), [
            "attempt_id",
            "chat_guid_hash",
            "created_at",
            "failure_code",
            "state",
            "updated_at"
        ]);

        // The entity metadata and the migrated schema agree: synchronize would change nothing
        const pending = await db.driver.createSchemaBuilder().log();
        assert.deepEqual(
            pending.upQueries.map(query => query.query),
            [],
            "entity and migration disagree"
        );

        const insert = (values: unknown[]) =>
            db.query(
                `INSERT INTO recoverable_delete_receipt
                    (attempt_id, chat_guid_hash, state, failure_code, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                values
            );
        const hash = hashRecoverableDeleteChatGuid(CHAT);
        await insert([attempt("valid"), hash, "pending", null, 1, 1]);
        await assert.rejects(insert([attempt("valid"), hash, "pending", null, 1, 1]), /UNIQUE|PRIMARY/);
        await assert.rejects(insert([attempt("badstate"), hash, "done", null, 1, 1]), /CHECK/);
        await assert.rejects(insert(["short", hash, "pending", null, 1, 1]), /CHECK/);
        await assert.rejects(insert([attempt("rawguid"), CHAT, "pending", null, 1, 1]), /CHECK/);
        await assert.rejects(insert([attempt("nocode"), hash, "definitiveFailure", null, 1, 1]), /CHECK/);
        await assert.rejects(insert([attempt("strayCode"), hash, "pending", "x", 1, 1]), /CHECK/);
        await assert.rejects(insert([attempt("nulltime"), hash, "pending", null, null, 1]), /NOT NULL/);

        const repository = db.getRepository(RecoverableDeleteReceipt);
        assert.equal((await repository.findOneByOrFail({ attemptId: attempt("valid") })).state, "pending");

        await db.undoLastMigration();
        assert.equal(await db.createQueryRunner().hasTable("recoverable_delete_receipt"), false);
    });
});

test("attempt ids must be bounded base64url strings", () => {
    assert.equal(isValidRecoverableDeleteAttemptId("A".repeat(16)), true);
    assert.equal(isValidRecoverableDeleteAttemptId("aZ09-_".repeat(21) + "ab"), true);
    for (const bad of [
        "A".repeat(15),
        "A".repeat(129),
        "a".repeat(15) + "=",
        "a".repeat(16) + "/x",
        "../" + "a".repeat(16),
        "a".repeat(16) + "\n",
        "a".repeat(16) + "%2F",
        ["a".repeat(16)],
        1234567890123456,
        null,
        undefined,
        { attemptId: "a".repeat(16) }
    ]) {
        assert.equal(isValidRecoverableDeleteAttemptId(bad), false, JSON.stringify(bad));
    }
});

test("pending is committed and visible to another connection while the helper is paused", async () => {
    await withReceiptDatabase(async (db, database) => {
        const observer = createReceiptDataSource(database);
        await observer.initialize();
        try {
            const service = new RecoverableDeleteReceiptService(db);
            let release: () => void;
            const paused = new Promise<void>(resolve => {
                release = resolve;
            });
            let helperEntered: () => void;
            const entered = new Promise<void>(resolve => {
                helperEntered = resolve;
            });
            let rowAtDispatch: RecoverableDeleteReceipt | null = null;

            const submission = service.submit(attempt("pending"), CHAT, async () => {
                rowAtDispatch = await rowFor(observer, attempt("pending"));
                helperEntered();
                await paused;
            });

            await entered;
            assert.equal(rowAtDispatch?.state, "pending");
            const whilePaused = await rowFor(observer, attempt("pending"));
            assert.equal(whilePaused?.state, "pending");
            assert.equal(whilePaused?.chatGuidHash, hashRecoverableDeleteChatGuid(CHAT));
            assert.notEqual(whilePaused?.chatGuidHash, CHAT);

            release!();
            const result = await submission;
            assert.equal(result.state, "succeeded");
            assert.equal((await rowFor(observer, attempt("pending")))?.state, "succeeded");
        } finally {
            await observer.destroy();
        }
    });
});

test("a failed pending insert never invokes the helper", async () => {
    await withReceiptDatabase(async db => {
        const service = new RecoverableDeleteReceiptService(db);
        let helperCalls = 0;
        const helper = async () => {
            helperCalls += 1;
        };

        await db.query(`
            CREATE TRIGGER block_receipt_insert BEFORE INSERT ON recoverable_delete_receipt
            BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END;
        `);
        await assert.rejects(service.submit(attempt("insertfail"), CHAT, helper), /simulated insert failure/);
        await db.query(`DROP TRIGGER block_receipt_insert`);

        // A row the database refuses (attempt id below the CHECK bound) also stops dispatch
        await assert.rejects(service.submit("tooShort", CHAT, helper), /CHECK/);

        await db.destroy();
        await assert.rejects(service.submit(attempt("closeddb"), CHAT, helper));

        assert.equal(helperCalls, 0);
    });
});

test("two service instances sharing one SQLite file dispatch each attempt exactly once", async () => {
    await withDatabaseFile(async database => {
        const firstDb = createReceiptDataSource(database);
        const secondDb = createReceiptDataSource(database);
        await firstDb.initialize();
        await secondDb.initialize();
        try {
            const first = new RecoverableDeleteReceiptService(firstDb);
            const second = new RecoverableDeleteReceiptService(secondDb);
            const calls = new Map<string, number>();
            const helperFor = (id: string) => async () => {
                calls.set(id, (calls.get(id) ?? 0) + 1);
                await new Promise(resolve => setTimeout(resolve, 5));
            };

            const ids = Array.from({ length: 20 }, (_, i) => attempt(`race${i}`));
            const results = await Promise.all(
                ids.flatMap(id => [
                    first.submit(id, CHAT, helperFor(id)),
                    second.submit(id, CHAT, helperFor(id)),
                    second.submit(id, CHAT, helperFor(id))
                ])
            );

            for (const id of ids) assert.equal(calls.get(id), 1, id);
            assert.equal(results.length, 60);
            for (const id of ids) {
                assert.equal((await first.get(id))?.state, "succeeded");
                assert.equal((await second.get(id))?.state, "succeeded");
            }
        } finally {
            await secondDb.destroy();
            await firstDb.destroy();
        }
    });
});

test("a restarted service reconstructs receipts from SQLite and never replays", async () => {
    await withDatabaseFile(async database => {
        let helperCalls = 0;
        const beforeRestart = createReceiptDataSource(database);
        await beforeRestart.initialize();
        const service = new RecoverableDeleteReceiptService(beforeRestart);

        // Crash while dispatching: the helper never answers and the process goes away
        let entered: () => void;
        const helperEntered = new Promise<void>(resolve => {
            entered = resolve;
        });
        void service
            .submit(attempt("crashed"), CHAT, () => {
                helperCalls += 1;
                entered();
                return new Promise(() => undefined);
            })
            .catch(() => undefined);
        await helperEntered;
        await service.submit(attempt("finished"), CHAT, async () => {
            helperCalls += 1;
        });
        await beforeRestart.destroy();
        assert.equal(helperCalls, 2);

        const afterRestart = createReceiptDataSource(database);
        await afterRestart.initialize();
        try {
            const restarted = new RecoverableDeleteReceiptService(afterRestart);
            const replay = async () => {
                helperCalls += 1;
            };

            assert.equal((await restarted.get(attempt("crashed")))?.state, "pending");
            assert.equal((await restarted.submit(attempt("crashed"), CHAT, replay)).state, "pending");
            assert.equal((await restarted.submit(attempt("finished"), CHAT, replay)).state, "succeeded");
            assert.equal(helperCalls, 2);
        } finally {
            await afterRestart.destroy();
        }
    });
});

test("an attempt bound to one chat conflicts for a different chat without a helper call", async () => {
    await withReceiptDatabase(async db => {
        const service = new RecoverableDeleteReceiptService(db);
        let helperCalls = 0;
        const helper = async () => {
            helperCalls += 1;
        };

        await service.submit(attempt("chatbound"), CHAT, helper);
        await assert.rejects(service.submit(attempt("chatbound"), OTHER_CHAT, helper), DeleteAttemptConflictError);
        const again = await service.submit(attempt("chatbound"), CHAT, helper);

        assert.equal(again.state, "succeeded");
        assert.equal(helperCalls, 1);
        assert.equal((await rowFor(db, attempt("chatbound")))?.chatGuidHash, hashRecoverableDeleteChatGuid(CHAT));
    });
});

test("outcomes: only helper success or a typed pre-dispatch error leave pending", async () => {
    await withReceiptDatabase(async db => {
        const logs: string[] = [];
        const service = new RecoverableDeleteReceiptService(db, message => logs.push(message));
        const outcome = async (label: string, helper: () => Promise<unknown>) => {
            const view = await service.submit(attempt(label), CHAT, helper);
            const row = await rowFor(db, attempt(label));
            assert.equal(view.state, row?.state, label);
            return row;
        };

        const succeeded = await outcome("success", async () => ({ identifier: "x" }));
        assert.equal(succeeded?.state, "succeeded");
        assert.equal(succeeded?.failureCode, null);

        const definitive = await outcome("typed", async () => {
            throw new RecoverableDeletePreDispatchError("privateApiUnavailable", "helper offline");
        });
        assert.equal(definitive?.state, "definitiveFailure");
        assert.equal(definitive?.failureCode, "privateApiUnavailable");

        const ambiguous: Array<[string, () => Promise<unknown>]> = [
            ["timeout", () => Promise.reject("Transaction timeout")],
            ["transport", () => Promise.reject(new Error("Failed to send recoverable chat deletion"))],
            ["unknown", () => Promise.reject(new TypeError("boom"))],
            ["undefinedErr", () => Promise.reject(undefined)],
            // Same message as a pre-dispatch failure, but untyped: must not be trusted
            ["lookalike", () => Promise.reject(new Error("iMessage Private API Helper is not connected!"))],
            [
                "forgedFlag",
                () => Promise.reject(Object.assign(new Error("x"), { preDispatch: true, code: "unsupportedMacOS" }))
            ]
        ];
        for (const [label, helper] of ambiguous) {
            const row = await outcome(label, helper);
            assert.equal(row?.state, "pending", label);
            assert.equal(row?.failureCode, null, label);
        }

        // Terminal-write failure after helper success: no throw, receipt stays pending, no retry
        let helperCalls = 0;
        await db.query(`
            CREATE TRIGGER block_receipt_update BEFORE UPDATE ON recoverable_delete_receipt
            BEGIN SELECT RAISE(ABORT, 'simulated terminal write failure'); END;
        `);
        const view = await service.submit(attempt("termwrite"), CHAT, async () => {
            helperCalls += 1;
        });
        assert.equal(view.state, "pending");
        const typedView = await service.submit(attempt("termwriteTyped"), CHAT, async () => {
            helperCalls += 1;
            throw new RecoverableDeletePreDispatchError("unsupportedMacOS", "old macOS");
        });
        assert.equal(typedView.state, "pending");
        await db.query(`DROP TRIGGER block_receipt_update`);
        assert.equal((await rowFor(db, attempt("termwrite")))?.state, "pending");
        assert.equal((await rowFor(db, attempt("termwriteTyped")))?.state, "pending");
        assert.equal(
            (
                await service.submit(attempt("termwrite"), CHAT, async () => {
                    helperCalls += 1;
                })
            ).state,
            "pending"
        );
        assert.equal(helperCalls, 2);

        assert.ok(logs.length > 0);
        for (const line of logs) assert.ok(!line.includes(CHAT), "raw chat GUID logged");
    });
});
