import crypto from "node:crypto";

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
