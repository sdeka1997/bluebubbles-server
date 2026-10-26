import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Test-only builders for encrypted LocalStorage.db images and SQLite WAL files. */

export const PAGE_SIZE = 4096;
export const KEY = Buffer.alloc(32, 0x11);

/**
 * A plaintext page as SQLite would hand it to the codec: content filled with `fill`, and the
 * 12 reserved tail bytes holding the per-page nonce. Page 1 starts with a real SQLite header.
 */
export const plainPage = (pgno: number, fill: number): Buffer => {
    const page = Buffer.alloc(PAGE_SIZE, fill);
    if (pgno === 1) {
        page.fill(0, 0, 100);
        page.write("SQLite format 3\0", 0, "binary");
        page.writeUInt16BE(PAGE_SIZE, 16);
        page.set([1, 1, 12, 64, 32, 32], 18);
    }
    crypto
        .createHash("sha256")
        .update(`nonce-${pgno}-${fill}`)
        .digest()
        .copy(page, PAGE_SIZE - 12, 0, 12);
    return page;
};

/** Inverse of the codec (the XOR is symmetric); its keystream is pinned by the vectors above. */
export const encryptPage = (plain: Buffer, pgno: number, key: Buffer = KEY): Buffer => {
    const encrypted = Buffer.from(plain);
    const iv = Buffer.alloc(16);
    iv.writeUInt32LE(pgno, 0);
    plain.copy(iv, 4, PAGE_SIZE - 12);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    cipher.setAutoPadding(false);
    const keystream = Buffer.concat([cipher.update(Buffer.alloc(PAGE_SIZE)), cipher.final()]);
    for (let i = 0; i < PAGE_SIZE - 12; i++) encrypted[i] = plain[i] ^ keystream[i];
    if (pgno === 1) plain.copy(encrypted, 16, 16, 24);
    return encrypted;
};

export const encryptDb = (pages: Buffer[], key: Buffer = KEY): Buffer =>
    Buffer.concat(pages.map((page, i) => encryptPage(page, i + 1, key)));

// --- SQLite WAL writer (https://www.sqlite.org/fileformat2.html#walformat) ---

export const WAL_MAGIC_LE = 0x377f0682;
export const WAL_MAGIC_BE = 0x377f0683;
export const SALT1 = 0x01020304;
export const SALT2 = 0x0a0b0c0d;

/** SQLite's WAL checksum: Fibonacci-weighted sums over pairs of 32-bit words. */
const walChecksum = (data: Buffer, bigEndian: boolean, seed: [number, number] = [0, 0]): [number, number] => {
    let [s0, s1] = seed;
    for (let i = 0; i < data.length; i += 8) {
        const x0 = bigEndian ? data.readUInt32BE(i) : data.readUInt32LE(i);
        const x1 = bigEndian ? data.readUInt32BE(i + 4) : data.readUInt32LE(i + 4);
        s0 = (s0 + x0 + s1) >>> 0;
        s1 = (s1 + x1 + s0) >>> 0;
    }
    return [s0, s1];
};

export type TestFrame = { pgno: number; page: Buffer; commit?: number; salts?: [number, number] };

/** Builds real WAL bytes: a 32-byte header then 24-byte frame headers, all big-endian. */
export const buildWal = (
    frames: TestFrame[],
    { magic = WAL_MAGIC_LE, pageSize = PAGE_SIZE, salts = [SALT1, SALT2] as [number, number] } = {}
): Buffer => {
    const bigEndian = magic === WAL_MAGIC_BE;
    const header = Buffer.alloc(32);
    header.writeUInt32BE(magic, 0);
    header.writeUInt32BE(3007000, 4);
    header.writeUInt32BE(pageSize, 8);
    header.writeUInt32BE(0, 12);
    header.writeUInt32BE(salts[0], 16);
    header.writeUInt32BE(salts[1], 20);
    let sum = walChecksum(header.subarray(0, 24), bigEndian);
    header.writeUInt32BE(sum[0], 24);
    header.writeUInt32BE(sum[1], 28);

    const parts = [header];
    for (const frame of frames) {
        const frameHeader = Buffer.alloc(24);
        frameHeader.writeUInt32BE(frame.pgno, 0);
        frameHeader.writeUInt32BE(frame.commit ?? 0, 4);
        const frameSalts = frame.salts ?? salts;
        frameHeader.writeUInt32BE(frameSalts[0], 8);
        frameHeader.writeUInt32BE(frameSalts[1], 12);
        sum = walChecksum(frameHeader.subarray(0, 8), bigEndian, sum);
        sum = walChecksum(frame.page, bigEndian, sum);
        frameHeader.writeUInt32BE(sum[0], 16);
        frameHeader.writeUInt32BE(sum[1], 20);
        parts.push(frameHeader, frame.page);
    }
    return Buffer.concat(parts);
};

/**
 * Encrypts each page image of a plaintext WAL written by SQLite, as Apple's codec does before
 * the frame is written, and recomputes the chained frame checksums over the encrypted bytes.
 */
const encryptWal = (plainWal: Buffer, key: Buffer): Buffer => {
    const wal = Buffer.from(plainWal);
    const bigEndian = wal.readUInt32BE(0) === WAL_MAGIC_BE;
    let sum: [number, number] = [wal.readUInt32BE(24), wal.readUInt32BE(28)];
    for (let offset = 32, n = 0; offset + 24 + PAGE_SIZE <= wal.length; offset += 24 + PAGE_SIZE, n++) {
        const pgno = wal.readUInt32BE(offset);
        const page = Buffer.from(wal.subarray(offset + 24, offset + 24 + PAGE_SIZE));
        crypto
            .createHash("sha256")
            .update(`wal-nonce-${n}`)
            .digest()
            .copy(page, PAGE_SIZE - 12, 0, 12);
        encryptPage(page, pgno, key).copy(wal, offset + 24);
        sum = walChecksum(wal.subarray(offset, offset + 8), bigEndian, sum);
        sum = walChecksum(wal.subarray(offset + 24, offset + 24 + PAGE_SIZE), bigEndian, sum);
        wal.writeUInt32BE(sum[0], offset + 16);
        wal.writeUInt32BE(sum[1], offset + 20);
    }
    return wal;
};

/**
 * Builds a real SQLite database with `setup`, laid out the way Apple's codec needs it
 * (4096-byte pages, 12 reserved bytes per page), stamps a per-page nonce into the reserved
 * tail and encrypts it. Uses Node's built-in node:sqlite, so no native module is needed.
 */
export const buildEncryptedSqliteDb = (
    setup: (db: DatabaseSync) => void,
    key: Buffer = KEY,
    walSetup?: (db: DatabaseSync) => void
): { db: Buffer; wal: Buffer | null } => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "findmy-fixture-"));
    try {
        const file = path.join(dir, "fixture.db");
        // Pre-write page 1's header so SQLite adopts reserved-bytes = 12 for every page
        const header = Buffer.alloc(PAGE_SIZE);
        header.write("SQLite format 3\0", 0, "binary");
        header.writeUInt16BE(PAGE_SIZE, 16);
        header.set([1, 1, 12, 64, 32, 32], 18);
        header.writeUInt32BE(1, 24);
        header.writeUInt32BE(1, 28);
        header.writeUInt32BE(4, 44);
        header.writeUInt32BE(1, 56);
        header.writeUInt32BE(1, 92);
        header.writeUInt32BE(3045000, 96);
        header[100] = 0x0d;
        header.writeUInt16BE(PAGE_SIZE - 12, 105);
        fs.writeFileSync(file, header);

        const db = new DatabaseSync(file);
        setup(db);
        let wal: Buffer | null = null;
        if (walSetup) {
            db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
            db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            walSetup(db);
            // Copy while the connection is open: closing the last connection checkpoints the WAL away
            wal = encryptWal(fs.readFileSync(`${file}-wal`), key);
        }
        const plain = fs.readFileSync(file);
        db.close();

        const pages: Buffer[] = [];
        for (let i = 0; i < plain.length / PAGE_SIZE; i++) {
            const page = Buffer.from(plain.subarray(i * PAGE_SIZE, (i + 1) * PAGE_SIZE));
            crypto
                .createHash("sha256")
                .update(`db-nonce-${i}`)
                .digest()
                .copy(page, PAGE_SIZE - 12, 0, 12);
            pages.push(page);
        }
        return { db: encryptDb(pages, key), wal };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

/** Read-only node:sqlite opener matching the reader's injectable `openDb`. */
export const openNodeSqlite = (filePath: string) => new DatabaseSync(filePath, { readOnly: true });
