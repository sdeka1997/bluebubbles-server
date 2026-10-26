import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    cleanupStaleFindMyTemp,
    readStableEncryptedSnapshot,
    SnapshotIo,
    withDecryptedDb
} from "../src/server/api/lib/findmy/decrypt/localStorageReader";
import { encryptDb, KEY, plainPage } from "./findMyLocalStorageFixtures";

const withTempDir = <T>(fn: (dir: string) => T): T => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "findmy-reader-test-"));
    try {
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

test("reads the database and its WAL as one snapshot", () =>
    withTempDir(dir => {
        const dbPath = path.join(dir, "LocalStorage.db");
        fs.writeFileSync(dbPath, Buffer.from("db-bytes"));
        fs.writeFileSync(`${dbPath}-wal`, Buffer.from("wal-bytes"));

        assert.deepEqual(readStableEncryptedSnapshot(dbPath), {
            db: Buffer.from("db-bytes"),
            wal: Buffer.from("wal-bytes")
        });
        fs.unlinkSync(`${dbPath}-wal`);
        assert.deepEqual(readStableEncryptedSnapshot(dbPath), { db: Buffer.from("db-bytes"), wal: null });
    }));

/**
 * Fake filesystem whose files change between reads: `versions[path]` lists successive
 * contents, and each read of a path advances it to the next version (sticking at the last).
 */
const changingIo = (versions: Record<string, string[]>) => {
    const reads: Record<string, number> = {};
    const current = (p: string) => {
        const list = versions[p];
        return list ? list[Math.min(reads[p] ?? 0, list.length - 1)] : null;
    };
    const io: SnapshotIo = {
        stat: p => {
            const data = current(p);
            return data === null ? null : { size: data.length, mtimeMs: data.length, ino: 1, isFile: true };
        },
        read: p => {
            const data = current(p);
            reads[p] = (reads[p] ?? 0) + 1;
            return Buffer.from(data);
        }
    };
    return { io, reads };
};

test("re-reads when the database or WAL changes during the read", () => {
    const { io, reads } = changingIo({ "/db": ["db-v1", "db-v2-longer"], "/db-wal": ["wal"] });

    const snapshot = readStableEncryptedSnapshot("/db", { io });

    assert.deepEqual(snapshot, { db: Buffer.from("db-v2-longer"), wal: Buffer.from("wal") });
    assert.equal(reads["/db"], 2);
});

test("gives up with a clear error after a bounded number of attempts under continuous change", () => {
    let reads = 0;
    let tick = 0;
    const io: SnapshotIo = {
        stat: () => ({ size: 10, mtimeMs: tick++, ino: 1, isFile: true }),
        read: () => {
            // Guard so an unbounded retry loop fails the test instead of hanging it
            if (++reads > 20) throw new Error("runaway retry loop");
            return Buffer.alloc(10);
        }
    };

    assert.throws(() => readStableEncryptedSnapshot("/db", { io, maxAttempts: 3 }), /kept changing.*3 attempts/);
    assert.equal(reads, 6);
});

test("refuses a database or WAL path that is not a regular file", () =>
    withTempDir(dir => {
        const real = path.join(dir, "real.db");
        fs.writeFileSync(real, Buffer.from("db-bytes"));
        const dbPath = path.join(dir, "LocalStorage.db");
        fs.symlinkSync(real, dbPath);

        assert.throws(() => readStableEncryptedSnapshot(dbPath), /not a regular file/);

        fs.unlinkSync(dbPath);
        fs.writeFileSync(dbPath, Buffer.from("db-bytes"));
        fs.mkdirSync(`${dbPath}-wal`);
        assert.throws(() => readStableEncryptedSnapshot(dbPath), /not a regular file/);
    }));

test("fails clearly when the database does not exist", () =>
    withTempDir(dir => {
        assert.throws(
            () => readStableEncryptedSnapshot(path.join(dir, "LocalStorage.db")),
            /LocalStorage.db not found/
        );
    }));

/** Writes an encrypted LocalStorage.db built from `pages` (no WAL) into `dir`. */
const writeEncryptedDb = (dir: string, pages: Buffer[] = [plainPage(1, 0x00), plainPage(2, 0xa2)]): string => {
    const dbPath = path.join(dir, "LocalStorage.db");
    fs.writeFileSync(dbPath, encryptDb(pages));
    return dbPath;
};

test("decrypts into a fresh 0700 temp dir with a 0600 file and hands its path to the opener", () =>
    withTempDir(dir => {
        const tmpRoot = fs.mkdtempSync(path.join(dir, "tmp-"));
        const dbPath = writeEncryptedDb(dir);
        let seen: { dirMode: number; fileMode: number; dirName: string; bytes: Buffer } | null = null;

        const result = withDecryptedDb(KEY, dbPath, () => "query result", {
            tmpRoot,
            openDb: filePath => {
                seen = {
                    dirMode: fs.statSync(path.dirname(filePath)).mode & 0o777,
                    fileMode: fs.statSync(filePath).mode & 0o777,
                    dirName: path.basename(path.dirname(filePath)),
                    bytes: fs.readFileSync(filePath)
                };
                return { prepare: () => ({ all: () => [] }), close: () => undefined };
            }
        });

        assert.equal(result, "query result");
        assert.equal(seen.dirMode, 0o700);
        assert.equal(seen.fileMode, 0o600);
        assert.match(seen.dirName, /^bb-findmy-/);
        assert.equal(seen.bytes.subarray(0, 16).toString("binary"), "SQLite format 3\0");
        assert.equal(seen.bytes.length, 2 * 4096);
    }));

/** A fake database that records whether it was closed; `fail` makes queries throw. */
const fakeDb = (rows: Record<string, any[]> = {}) => {
    const state = { closed: false, path: "" };
    const openDb = (filePath: string) => {
        state.path = filePath;
        return {
            prepare: (sql: string) => ({
                all: () => {
                    const table = Object.keys(rows).find(name => sql.includes(name));
                    if (!table) throw new Error(`no such table in: ${sql}`);
                    return rows[table];
                }
            }),
            close: () => {
                state.closed = true;
            }
        };
    };
    return { state, openDb };
};

test("closes the database and removes the plaintext file and directory after success", () =>
    withTempDir(dir => {
        const tmpRoot = fs.mkdtempSync(path.join(dir, "tmp-"));
        const { state, openDb } = fakeDb();

        withDecryptedDb(KEY, writeEncryptedDb(dir), () => undefined, { tmpRoot, openDb });

        assert.equal(state.closed, true);
        assert.equal(fs.existsSync(state.path), false);
        assert.deepEqual(fs.readdirSync(tmpRoot), []);
    }));

test("still closes and removes the plaintext when the query throws", () =>
    withTempDir(dir => {
        const tmpRoot = fs.mkdtempSync(path.join(dir, "tmp-"));
        const { state, openDb } = fakeDb();

        assert.throws(
            () =>
                withDecryptedDb(
                    KEY,
                    writeEncryptedDb(dir),
                    () => {
                        throw new Error("query exploded");
                    },
                    { tmpRoot, openDb }
                ),
            /query exploded/
        );
        assert.equal(state.closed, true);
        assert.deepEqual(fs.readdirSync(tmpRoot), []);
    }));

test("removes the plaintext when the database cannot be opened", () =>
    withTempDir(dir => {
        const tmpRoot = fs.mkdtempSync(path.join(dir, "tmp-"));
        const openDb = (): never => {
            throw new Error("native module missing");
        };

        assert.throws(() => withDecryptedDb(KEY, writeEncryptedDb(dir), () => 1, { tmpRoot, openDb }), /native module/);
        assert.deepEqual(fs.readdirSync(tmpRoot), []);
    }));

test("cleanupStaleFindMyTemp removes only bb-findmy- leftovers", () =>
    withTempDir(tmpRoot => {
        fs.mkdirSync(path.join(tmpRoot, "bb-findmy-abc123"));
        fs.writeFileSync(path.join(tmpRoot, "bb-findmy-abc123", "LocalStorage.sqlite"), "plaintext");
        fs.mkdirSync(path.join(tmpRoot, "bb-findmyX"));
        fs.mkdirSync(path.join(tmpRoot, "other-app"));
        fs.writeFileSync(path.join(tmpRoot, "bb-findmy-file"), "not a dir");

        cleanupStaleFindMyTemp(tmpRoot);

        assert.deepEqual(fs.readdirSync(tmpRoot).sort(), ["bb-findmy-file", "bb-findmyX", "other-app"]);
    }));
