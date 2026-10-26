import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    cleanupStaleFindMyTemp,
    readFriendLocations,
    readStableEncryptedSnapshot,
    SnapshotIo,
    withDecryptedDb
} from "../src/server/api/lib/findmy/decrypt/localStorageReader";
import { buildEncryptedSqliteDb, encryptDb, KEY, openNodeSqlite, plainPage } from "./findMyLocalStorageFixtures";

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

// Binary plist (Python plistlib) of a secureLocations value:
// { latitude: 33.123456, longitude: -96.654321, horizontalAccuracy: 5, locationLabel: "$null",
//   timestamp: 2026-01-02T03:04:05Z }
const LOCATION_PLIST = Buffer.from(
    "YnBsaXN0MDDVAQIDBAUGBwgJCl8QEmhvcml6b250YWxBY2N1cmFjeVhsYXRpdHVkZV1sb2NhdGlvbkxhYmVsWWxvbmdpdHVkZVl0aW1lc3RhbXAjQBQAAAAAAAAjQECPzWf9P1tVJG51bGwjwFgp4GUwBYEzQceDtpKAAAAIEygxP0lTXGVrdAAAAAAAAAEBAAAAAAAAAAsAAAAAAAAAAAAAAAAAAAB9",
    "base64"
);

const writeLocationsDb = (dir: string, setup: Parameters<typeof buildEncryptedSqliteDb>[0]): string => {
    const dbPath = path.join(dir, "LocalStorage.db");
    fs.writeFileSync(dbPath, buildEncryptedSqliteDb(setup).db);
    return dbPath;
};

test("reads friend locations from a real encrypted LocalStorage.db", () =>
    withTempDir(dir => {
        const dbPath = writeLocationsDb(dir, db => {
            db.exec("CREATE TABLE secureLocations (serverUserID TEXT, value BLOB)");
            db.prepare("INSERT INTO secureLocations VALUES (?, ?)").run("friend-1~~", LOCATION_PLIST);
        });

        const locations = readFriendLocations(KEY, dbPath, { openDb: openNodeSqlite, tmpRoot: dir });

        assert.equal(locations.length, 1);
        assert.equal(locations[0].findMyId, "friend-1");
        assert.equal(locations[0].location.latitude, 33.123456);
        assert.equal(locations[0].location.longitude, -96.654321);
        assert.equal(locations[0].location.locationLabel, null);
        assert.equal((locations[0].location.timestamp as Date).getTime(), Date.UTC(2026, 0, 2, 3, 4, 5));
    }));

test("reads friend locations committed only to a real SQLite WAL", () =>
    withTempDir(dir => {
        const { db, wal } = buildEncryptedSqliteDb(
            setup => setup.exec("CREATE TABLE secureLocations (serverUserID TEXT, value BLOB)"),
            KEY,
            live => live.prepare("INSERT INTO secureLocations VALUES (?, ?)").run("friend-wal", LOCATION_PLIST)
        );
        const dbPath = path.join(dir, "LocalStorage.db");
        fs.writeFileSync(dbPath, db);
        fs.writeFileSync(`${dbPath}-wal`, wal);

        const locations = readFriendLocations(KEY, dbPath, { openDb: openNodeSqlite, tmpRoot: dir });

        assert.deepEqual(
            locations.map(l => l.findMyId),
            ["friend-wal"]
        );
    }));

test("skips rows with a missing id, a missing value or a malformed plist", () =>
    withTempDir(dir => {
        const dbPath = writeLocationsDb(dir, db => {
            db.exec("CREATE TABLE secureLocations (serverUserID TEXT, value BLOB)");
            const insert = db.prepare("INSERT INTO secureLocations VALUES (?, ?)");
            insert.run("good", LOCATION_PLIST);
            insert.run("truncated", LOCATION_PLIST.subarray(0, 40));
            insert.run("garbage", Buffer.from("not a plist"));
            insert.run("no-value", null);
            insert.run(null, LOCATION_PLIST);
            insert.run("~~", LOCATION_PLIST);
            insert.run("text-value", "bplist00");
        });

        const locations = readFriendLocations(KEY, dbPath, { openDb: openNodeSqlite, tmpRoot: dir });

        assert.deepEqual(
            locations.map(l => l.findMyId),
            ["good"]
        );
    }));

test("handles schema variants: a serverID key column, or no secureLocations table at all", () =>
    withTempDir(dir => {
        const variant = writeLocationsDb(dir, db => {
            db.exec("CREATE TABLE secureLocations (serverID TEXT, value BLOB, extra INTEGER)");
            db.prepare("INSERT INTO secureLocations (serverID, value) VALUES (?, ?)").run("friend-2~", LOCATION_PLIST);
        });
        assert.deepEqual(
            readFriendLocations(KEY, variant, { openDb: openNodeSqlite, tmpRoot: dir }).map(l => l.findMyId),
            ["friend-2"]
        );

        const missing = writeLocationsDb(dir, db => db.exec("CREATE TABLE friends (handleIdentifier TEXT)"));
        assert.deepEqual(readFriendLocations(KEY, missing, { openDb: openNodeSqlite, tmpRoot: dir }), []);

        const noValue = writeLocationsDb(dir, db => db.exec("CREATE TABLE secureLocations (serverUserID TEXT)"));
        assert.deepEqual(readFriendLocations(KEY, noValue, { openDb: openNodeSqlite, tmpRoot: dir }), []);
    }));

test("drops locations without finite in-range coordinates, including Apple's (0, 0) no-fix", () =>
    withTempDir(dir => {
        const plistOf = (b64: string) => Buffer.from(b64, "base64");
        const dbPath = writeLocationsDb(dir, db => {
            db.exec("CREATE TABLE secureLocations (serverUserID TEXT, value BLOB)");
            const insert = db.prepare("INSERT INTO secureLocations VALUES (?, ?)");
            insert.run("good", LOCATION_PLIST);
            // latitude 0, longitude 32.5: on the equator, a real location
            insert.run(
                "equator",
                plistOf(
                    "YnBsaXN0MDDSAQIDBFhsYXRpdHVkZVlsb25naXR1ZGUjAAAAAAAAAAAjQEBAAAAAAAAIDRYgKQAAAAAAAAEBAAAAAAAAAAUAAAAAAAAAAAAAAAAAAAAy"
                )
            );
            // latitude 0, longitude 0
            insert.run(
                "zero",
                plistOf(
                    "YnBsaXN0MDDVAQIDBAUGBwgHCV8QEmhvcml6b250YWxBY2N1cmFjeVhsYXRpdHVkZV1sb2NhdGlvbkxhYmVsWWxvbmdpdHVkZVl0aW1lc3RhbXAjQBQAAAAAAAAjAAAAAAAAAABVJG51bGwzQceDtpKAAAAIEygxP0lTXGVrAAAAAAAAAQEAAAAAAAAACgAAAAAAAAAAAAAAAAAAAHQ="
                )
            );
            // latitude 123 (out of range)
            insert.run(
                "out-of-range",
                plistOf(
                    "YnBsaXN0MDDVAQIDBAUGBwgJCl8QEmhvcml6b250YWxBY2N1cmFjeVhsYXRpdHVkZV1sb2NhdGlvbkxhYmVsWWxvbmdpdHVkZVl0aW1lc3RhbXAjQBQAAAAAAAAjQF7AAAAAAABVJG51bGwjQCQAAAAAAAAzQceDtpKAAAAIEygxP0lTXGVrdAAAAAAAAAEBAAAAAAAAAAsAAAAAAAAAAAAAAAAAAAB9"
                )
            );
            // longitude only
            insert.run(
                "no-latitude",
                plistOf("YnBsaXN0MDDRAQJZbG9uZ2l0dWRlIz/wAAAAAAAACAsVAAAAAAAAAQEAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAB4=")
            );
        });

        const locations = readFriendLocations(KEY, dbPath, { openDb: openNodeSqlite, tmpRoot: dir });

        assert.deepEqual(
            locations.map(l => l.findMyId),
            ["good", "equator"]
        );
    }));
