import fs from "fs";
import os from "os";
import path from "path";
import { normalizePlistNulls } from "./cache";
import { decryptLocalStorageSnapshot, EncryptedLocalStorageSnapshot } from "./localStorage";
import { parsePlistBuffer } from "./plistUtils";

export type FileFingerprint = { size: number; mtimeMs: number; ino: number; isFile: boolean };

/** Filesystem access used to snapshot Apple's database; injectable for tests. */
export type SnapshotIo = {
    /** Metadata without following symlinks, or null if the file does not exist. */
    stat: (filePath: string) => FileFingerprint | null;
    read: (filePath: string) => Buffer;
};

const nodeIo: SnapshotIo = {
    stat: filePath => {
        try {
            const stat = fs.lstatSync(filePath);
            return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, isFile: stat.isFile() };
        } catch (ex: any) {
            if (ex?.code === "ENOENT") return null;
            throw ex;
        }
    },
    read: filePath => {
        // O_NOFOLLOW closes the gap between lstat and open; O_NONBLOCK keeps a FIFO from hanging open()
        const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
            return fs.readFileSync(fd);
        } finally {
            fs.closeSync(fd);
        }
    }
};

const assertRegularFile = (filePath: string, stat: FileFingerprint | null): void => {
    // A symlink to a device would make the synchronous read block the main thread forever
    if (stat && !stat.isFile) throw new Error(`Find My LocalStorage path is not a regular file: ${filePath}`);
};

const sameFile = (a: FileFingerprint | null, b: FileFingerprint | null): boolean =>
    a === b || (a !== null && b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino);

/**
 * Read the encrypted LocalStorage.db and its WAL as one consistent snapshot. Find My keeps
 * writing while we read, so both files are fingerprinted before and after; if either changed
 * the read is retried. Read-only: Apple's files are never opened for writing or locked.
 */
export const readStableEncryptedSnapshot = (
    dbPath: string,
    {
        walPath = `${dbPath}-wal`,
        io = nodeIo,
        maxAttempts = 3
    }: { walPath?: string; io?: SnapshotIo; maxAttempts?: number } = {}
): EncryptedLocalStorageSnapshot => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const dbBefore = io.stat(dbPath);
        const walBefore = io.stat(walPath);
        if (!dbBefore) throw new Error(`Find My LocalStorage.db not found at ${dbPath}`);
        assertRegularFile(dbPath, dbBefore);
        assertRegularFile(walPath, walBefore);
        const db = io.read(dbPath);
        const wal = walBefore ? io.read(walPath) : null;
        if (sameFile(dbBefore, io.stat(dbPath)) && sameFile(walBefore, io.stat(walPath))) return { db, wal };
    }

    throw new Error(`LocalStorage.db kept changing while being read; gave up after ${maxAttempts} attempts`);
};

/** The slice of better-sqlite3's Database used here; injectable so tests need no native module. */
export type FindMyDb = {
    prepare: (sql: string) => { all: (...params: any[]) => any[] };
    close: () => void;
};

export type DecryptedDbOptions = {
    walPath?: string;
    io?: SnapshotIo;
    /** Parent for the private plaintext directory (defaults to os.tmpdir()). */
    tmpRoot?: string;
    openDb?: (filePath: string) => FindMyDb;
};

// Plaintext lives only in directories with this prefix, so stale-file cleanup can't touch anything else
export const FIND_MY_TEMP_PREFIX = "bb-findmy-";

const openReadOnly = (filePath: string): FindMyDb => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require("better-sqlite3");
    return new Database(filePath, { readonly: true, fileMustExist: true });
};

/**
 * Decrypt a stable snapshot of LocalStorage.db to a private temporary file, run `fn` against
 * it, then remove the plaintext.
 */
export const withDecryptedDb = <T>(
    key: Buffer,
    dbPath: string,
    fn: (db: FindMyDb) => T,
    { walPath, io, tmpRoot = os.tmpdir(), openDb = openReadOnly }: DecryptedDbOptions = {}
): T => {
    const plaintext = decryptLocalStorageSnapshot(key, readStableEncryptedSnapshot(dbPath, { walPath, io }));
    // mkdtemp creates the directory 0700 with an unpredictable name; chmod again in case of an odd umask
    const dir = fs.mkdtempSync(path.join(tmpRoot, FIND_MY_TEMP_PREFIX));
    let db: FindMyDb | null = null;
    try {
        fs.chmodSync(dir, 0o700);
        const filePath = path.join(dir, "LocalStorage.sqlite");
        fs.writeFileSync(filePath, plaintext, { mode: 0o600, flag: "wx" });
        db = openDb(filePath);
        return fn(db);
    } finally {
        try {
            db?.close();
        } catch {
            // the plaintext is removed below regardless
        }
        // Removes the db and any -wal/-shm SQLite created beside it
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

/**
 * Remove plaintext directories left behind by a crash mid-read. Only real directories named
 * with our prefix are touched; symlinks and anything else in the temp dir are left alone.
 */
export const cleanupStaleFindMyTemp = (tmpRoot: string = os.tmpdir()): void => {
    for (const entry of fs.readdirSync(tmpRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith(FIND_MY_TEMP_PREFIX)) continue;
        fs.rmSync(path.join(tmpRoot, entry.name), { recursive: true, force: true });
    }
};

export type RawFriendLocation = {
    /** Apple's opaque Find My friend id (serverUserID), trailing `~` padding stripped. */
    findMyId: string;
    /** Parsed `secureLocations.value` plist (latitude/longitude/timestamp/...), "$null" -> null. */
    location: Record<string, any>;
};

// better-sqlite3 returns BLOBs as Buffer, node:sqlite as Uint8Array
const isBlob = (value: unknown): value is Uint8Array => value instanceof Uint8Array && value.length > 0;

/**
 * Finite, in-range coordinates. `typeof NaN` is "number", so check `Number.isFinite`; and
 * (0, 0) is Apple's "no fix" placeholder, which would otherwise overwrite a known position.
 */
const hasUsableCoordinates = (location: any): boolean => {
    const { latitude, longitude } = location ?? {};
    return (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 &&
        Math.abs(longitude) <= 180 &&
        (latitude !== 0 || longitude !== 0)
    );
};

const stripPadding = (id: string): string => id.replace(/~+$/, "");

/**
 * Reads friend coordinates from the encrypted LocalStorage.db. `secureLocations` holds one
 * coordinate plist per friend, keyed by Apple's opaque id.
 */
export const readFriendLocations = (
    key: Buffer,
    dbPath: string,
    options: DecryptedDbOptions = {}
): RawFriendLocation[] =>
    withDecryptedDb(
        key,
        dbPath,
        db => {
            const columns = new Set(
                db
                    .prepare("PRAGMA table_info(secureLocations)")
                    .all()
                    .map(column => column.name)
            );
            // Column names vary across macOS releases; anything unrecognised means no locations
            const idColumn = ["serverUserID", "serverID"].find(name => columns.has(name));
            if (!idColumn || !columns.has("value")) return [];

            const rows = db.prepare(`SELECT ${idColumn} AS id, value FROM secureLocations`).all();
            const out: RawFriendLocation[] = [];
            for (const row of rows) {
                const findMyId = typeof row.id === "string" ? stripPadding(row.id) : "";
                if (!findMyId || !isBlob(row.value)) continue;
                try {
                    const location = normalizePlistNulls(parsePlistBuffer(Buffer.from(row.value)));
                    if (hasUsableCoordinates(location)) {
                        out.push({ findMyId, location });
                    }
                } catch {
                    // One unreadable row must not cost every other friend's location
                }
            }
            return out;
        },
        options
    );
