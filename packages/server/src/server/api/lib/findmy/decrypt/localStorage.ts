import crypto from "crypto";

/**
 * Decryption for Apple Find My's encrypted `LocalStorage.db` (friend coordinates).
 *
 * This is NOT standard SQLCipher. Apple's `sqliteCodecCCCrypto` encrypts each 4096-byte
 * SQLite page independently using an AES-256 keystream-XOR (CTR-like) construction:
 *   keystream = AES-256-CBC-ENCRYPT(key, iv, zeros[4096])
 *   plaintext = ciphertext[0:4084] XOR keystream[0:4084]
 * where iv = LE32(pgno) ‖ reserved(12 bytes from the page tail) and pgno is 1-based.
 *
 * Ported from #810 (itself from findmy-key-extractor/decrypt_localstorage.py).
 *
 * The WAL is encrypted too, with the same per-page transform, but only the page images:
 * SQLite's codec hook (`sqlite3PagerCodec` in `walWriteOneFrame`) encrypts each page before
 * `walEncodeFrame` writes it, so the 32-byte WAL header and 24-byte frame headers are
 * plaintext and the frame checksums are computed over the *encrypted* page bytes. #810's
 * applyWal decrypted frames the same way (keyed by the frame's page number), and the frame
 * IV uses that page number, so a WAL frame decrypts exactly like the same page in the db.
 */

export const LOCAL_STORAGE_PAGE_SIZE = 4096;
const RESERVED_LEN = 12;
const CONTENT_LEN = LOCAL_STORAGE_PAGE_SIZE - RESERVED_LEN;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");

// SQLite page numbers are 1-based and stored as a u32; 0xFFFFFFFF is never a valid page.
const isValidPageNumber = (pgno: number): boolean => Number.isInteger(pgno) && pgno >= 1 && pgno <= 0xfffffffe;

const assertKey = (key: Buffer): void => {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
        throw new Error(`Expected a 32-byte LocalStorage key, got ${key?.length ?? 0} bytes`);
    }
};

/**
 * Decrypt one page. Returns a new buffer; the input is never modified.
 *
 * @param pgno 1-based SQLite page number (it is part of the IV)
 */
export const decryptLocalStoragePage = (key: Buffer, page: Buffer, pgno: number): Buffer => {
    assertKey(key);
    if (page.length !== LOCAL_STORAGE_PAGE_SIZE) {
        throw new Error(`LocalStorage page must be ${LOCAL_STORAGE_PAGE_SIZE} bytes, got ${page.length}`);
    }
    if (!isValidPageNumber(pgno)) throw new Error(`Invalid LocalStorage page number ${pgno}`);
    const reserved = page.subarray(CONTENT_LEN, LOCAL_STORAGE_PAGE_SIZE);

    const iv = Buffer.alloc(16);
    iv.writeUInt32LE(pgno, 0);
    reserved.copy(iv, 4);

    // Generate the keystream by CBC-*encrypting* zeros (autopadding off so output stays 4096 bytes)
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    cipher.setAutoPadding(false);
    const keystream = Buffer.concat([cipher.update(Buffer.alloc(LOCAL_STORAGE_PAGE_SIZE)), cipher.final()]);

    const result = Buffer.alloc(LOCAL_STORAGE_PAGE_SIZE);
    for (let i = 0; i < CONTENT_LEN; i++) {
        result[i] = page[i] ^ keystream[i];
    }
    reserved.copy(result, CONTENT_LEN);

    // Page 1: bytes 16-23 (page size, format versions, reserved size) are stored in plaintext
    if (pgno === 1) page.copy(result, 16, 16, 24);

    return result;
};

/**
 * Decrypt every page of an encrypted LocalStorage.db image into a new plaintext buffer.
 */
export const decryptLocalStorageDatabase = (key: Buffer, data: Buffer): Buffer => {
    if (data.length === 0) throw new Error("LocalStorage.db is empty");
    if (data.length % LOCAL_STORAGE_PAGE_SIZE !== 0) {
        throw new Error(`LocalStorage.db is not a whole number of pages (${data.length} bytes)`);
    }
    // Bytes 16-17 of page 1 are stored in plaintext; the codec only handles 4096-byte pages
    const headerPageSize = data.readUInt16BE(16);
    if (headerPageSize !== LOCAL_STORAGE_PAGE_SIZE) {
        throw new Error(`Unsupported LocalStorage.db page size ${headerPageSize}`);
    }

    const numPages = data.length / LOCAL_STORAGE_PAGE_SIZE;
    const pages: Buffer[] = [];
    for (let i = 0; i < numPages; i++) {
        const page = data.subarray(i * LOCAL_STORAGE_PAGE_SIZE, (i + 1) * LOCAL_STORAGE_PAGE_SIZE);
        pages.push(decryptLocalStoragePage(key, page, i + 1));
    }

    const output = Buffer.concat(pages);
    if (!output.subarray(0, 16).equals(SQLITE_MAGIC)) {
        throw new Error("LocalStorage.db decryption failed: page 1 is not a SQLite header (wrong key?)");
    }

    return output;
};

// Magic's low bit says which byte order the checksums were computed in (1 = big-endian)
const WAL_MAGIC_LE = 0x377f0682;
const WAL_MAGIC_BE = 0x377f0683;
const WAL_HEADER_SIZE = 32;
const WAL_FRAME_HEADER_SIZE = 24;
const WAL_FRAME_SIZE = WAL_FRAME_HEADER_SIZE + LOCAL_STORAGE_PAGE_SIZE;

export type WalFrame = {
    pgno: number;
    /** The frame's (still encrypted) page image; a view into the WAL buffer. */
    page: Buffer;
};

export type CommittedWal = {
    /** Frames of every committed transaction, in log order (later frames win). */
    frames: WalFrame[];
    /** Database size in pages after the last commit. */
    dbPages: number;
};

/**
 * SQLite's WAL checksum (fileformat2.html#walformat): Fibonacci-weighted sums over pairs of
 * 32-bit words, read in the byte order named by the WAL magic, chained from `seed`.
 */
const walChecksum = (data: Buffer, bigEndian: boolean, s0: number, s1: number): [number, number] => {
    for (let i = 0; i + 8 <= data.length; i += 8) {
        const x0 = bigEndian ? data.readUInt32BE(i) : data.readUInt32LE(i);
        const x1 = bigEndian ? data.readUInt32BE(i + 4) : data.readUInt32LE(i + 4);
        s0 = (s0 + x0 + s1) >>> 0;
        s1 = (s1 + x1 + s0) >>> 0;
    }
    return [s0, s1];
};

/**
 * Parse the committed prefix of a SQLite WAL. Frames after the last commit frame (one with
 * a nonzero "database size" field) belong to a transaction still being written and are
 * ignored, as SQLite's own recovery does.
 *
 * @returns null when the WAL holds no committed transaction.
 */
export const parseCommittedWalFrames = (wal: Buffer): CommittedWal | null => {
    // SQLite truncates or rewrites the WAL after a checkpoint; a short file has nothing committed
    if (wal.length < WAL_HEADER_SIZE) return null;

    const magic = wal.readUInt32BE(0);
    if (magic !== WAL_MAGIC_LE && magic !== WAL_MAGIC_BE) {
        throw new Error(`Invalid WAL magic 0x${magic.toString(16)}`);
    }
    const pageSize = wal.readUInt32BE(8);
    if (pageSize !== LOCAL_STORAGE_PAGE_SIZE) throw new Error(`Unsupported WAL page size ${pageSize}`);

    const bigEndian = magic === WAL_MAGIC_BE;
    const salt1 = wal.readUInt32BE(16);
    const salt2 = wal.readUInt32BE(20);
    let [s0, s1] = walChecksum(wal.subarray(0, 24), bigEndian, 0, 0);
    if (wal.readUInt32BE(24) !== s0 || wal.readUInt32BE(28) !== s1) {
        // SQLite would silently ignore such a WAL; failing instead lets the caller re-read
        // rather than serve the stale main database from a header torn mid-rewrite
        throw new Error("Invalid WAL header checksum");
    }

    const committed: WalFrame[] = [];
    let pending: WalFrame[] = [];
    let dbPages = 0;

    for (let offset = WAL_HEADER_SIZE; offset + WAL_FRAME_SIZE <= wal.length; offset += WAL_FRAME_SIZE) {
        // A salt mismatch marks a leftover frame from before the last WAL reset: the valid log ends here
        if (wal.readUInt32BE(offset + 8) !== salt1 || wal.readUInt32BE(offset + 12) !== salt2) break;

        // Each frame's checksum covers its first 8 header bytes and page, chained from the
        // previous frame; a mismatch is a torn or partially-written frame, so the log ends here
        const page = wal.subarray(offset + WAL_FRAME_HEADER_SIZE, offset + WAL_FRAME_SIZE);
        [s0, s1] = walChecksum(wal.subarray(offset, offset + 8), bigEndian, s0, s1);
        [s0, s1] = walChecksum(page, bigEndian, s0, s1);
        if (wal.readUInt32BE(offset + 16) !== s0 || wal.readUInt32BE(offset + 20) !== s1) break;

        const pgno = wal.readUInt32BE(offset);
        const commitSize = wal.readUInt32BE(offset + 4);
        // Checksums passed, so this is what SQLite wrote: an impossible page number is corruption
        if (!isValidPageNumber(pgno)) throw new Error(`Invalid WAL frame page number ${pgno}`);
        pending.push({ pgno, page });

        if (commitSize !== 0) {
            committed.push(...pending);
            pending = [];
            dbPages = commitSize;
        }
    }

    return committed.length > 0 ? { frames: committed, dbPages } : null;
};

/**
 * Apply the committed WAL frames on top of a decrypted database image. Returns a new buffer;
 * neither input is modified.
 */
export const applyCommittedWal = (key: Buffer, db: Buffer, wal: Buffer): Buffer => {
    const committed = parseCommittedWalFrames(wal);
    if (!committed) return Buffer.from(db);

    // The last commit's size is authoritative: it grows the file or truncates it (e.g. after
    // VACUUM). Pages beyond it are not part of the database, whichever frame wrote them.
    const output = Buffer.alloc(committed.dbPages * LOCAL_STORAGE_PAGE_SIZE);
    db.copy(output, 0, 0, Math.min(db.length, output.length));
    for (const { pgno, page } of committed.frames) {
        if (pgno > committed.dbPages) continue;
        decryptLocalStoragePage(key, page, pgno).copy(output, (pgno - 1) * LOCAL_STORAGE_PAGE_SIZE);
    }
    return output;
};

export type EncryptedLocalStorageSnapshot = {
    /** Raw bytes of the encrypted LocalStorage.db. */
    db: Buffer;
    /** Raw bytes of LocalStorage.db-wal, or null if there is none. */
    wal: Buffer | null;
};

/**
 * Decrypt a consistent LocalStorage.db + WAL snapshot into a plaintext SQLite image.
 */
export const decryptLocalStorageSnapshot = (key: Buffer, snapshot: EncryptedLocalStorageSnapshot): Buffer => {
    const db = decryptLocalStorageDatabase(key, snapshot.db);
    return snapshot.wal ? applyCommittedWal(key, db, snapshot.wal) : db;
};
