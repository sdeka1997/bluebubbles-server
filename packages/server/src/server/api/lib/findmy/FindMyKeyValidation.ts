import fs from "fs";
import path from "path";
import { FindMyKeyManager, FindMyKeyType } from "./FindMyKeyManager";
import { decryptCacheBuffer } from "./decrypt/cache";
import { decryptLocalStoragePage, LOCAL_STORAGE_PAGE_SIZE } from "./decrypt/localStorage";
import { extractSymmetricKey, parsePlistBuffer, readCacheFile } from "./decrypt/plistUtils";

/** Where Apple's encrypted caches live (FileSystem paths in production) */
export type FindMyKeyPaths = {
    localStorageDbPath: string;
    fmipCacheDir: string;
    fmfCacheDir: string;
};

const extractCacheKey = (_type: "FMIP" | "FMF", data: Buffer): Buffer | null =>
    extractSymmetricKey(parsePlistBuffer(data));

/** Reads only page 1 of LocalStorage.db, without following symlinks or blocking on a FIFO. */
const readFirstPage = (dbPath: string): Buffer => {
    const fd = fs.openSync(dbPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        if (!fs.fstatSync(fd).isFile()) throw new Error("LocalStorage.db is not a regular file");
        const page = Buffer.alloc(LOCAL_STORAGE_PAGE_SIZE);
        if (fs.readSync(fd, page, 0, page.length, 0) !== page.length) throw new Error("LocalStorage.db is truncated");
        return page;
    } finally {
        fs.closeSync(fd);
    }
};

/**
 * The key manager's deep check: a candidate key must decrypt the cache it belongs to, when
 * Find My has written that cache. Before then only the key's shape can be checked.
 */
const validateKey = (paths: FindMyKeyPaths) => (type: FindMyKeyType, data: Buffer) => {
    if (type === "LocalStorage") {
        if (!fs.existsSync(paths.localStorageDbPath)) return;
        const header = decryptLocalStoragePage(data, readFirstPage(paths.localStorageDbPath), 1);
        if (header.toString("binary", 0, 16) !== "SQLite format 3\0") {
            throw new Error("LocalStorage key does not decrypt LocalStorage.db");
        }
        return;
    }

    const key = extractCacheKey(type, data);
    if (!key) throw new Error(`${type} key file holds no 32-byte symmetric key`);
    const cachePath =
        type === "FMIP"
            ? path.join(paths.fmipCacheDir, "Devices.data")
            : path.join(paths.fmfCacheDir, "FriendCacheData.data");
    // Throws on a wrong key: the Poly1305 tag fails to authenticate
    if (fs.existsSync(cachePath)) decryptCacheBuffer(readCacheFile(cachePath), key);
};

/** The one key manager the server uses: keys live in `keysDir`, checked against Apple's caches. */
export const createFindMyKeyManager = (keysDir: string, paths: FindMyKeyPaths): FindMyKeyManager =>
    new FindMyKeyManager({ keysDir, validate: validateKey(paths), extractCacheKey });
