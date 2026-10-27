import assert from "node:assert/strict";
import test from "node:test";

import {
    applyCommittedWal,
    decryptLocalStorageDatabase,
    decryptLocalStoragePage,
    decryptLocalStorageSnapshot,
    parseCommittedWalFrames
} from "../src/server/api/lib/findmy/decrypt/localStorage";
import {
    buildWal,
    encryptDb,
    encryptPage,
    KEY,
    PAGE_SIZE,
    plainPage,
    SALT1,
    SALT2,
    WAL_MAGIC_BE
} from "./findMyLocalStorageFixtures";

// Known-answer vectors from LibreSSL, independent of Node's crypto:
//   head -c 4096 /dev/zero | openssl enc -aes-256-cbc -nopad -K 11..11 -iv <LE32(pgno) ‖ nonce>
// With an all-zero ciphertext body the decrypted bytes are the keystream itself.
const PAGE1_NONCE = Buffer.alloc(12, 0xcd);
const PAGE1_KEYSTREAM_0_32 = "8b039a2c6a7752a66849611e8d29ecb0e92386e9e0f687321fbca1c163107a41";
const PAGE3_NONCE = Buffer.alloc(12, 0xab);
const PAGE3_KEYSTREAM_4068_4084 = "0326c01ff01acb699cc6e6719ba1987a";

const zeroBodyPage = (nonce: Buffer): Buffer => Buffer.concat([Buffer.alloc(PAGE_SIZE - 12), nonce]);

/** Page `pgno` of a decrypted database image. */
const pageOf = (db: Buffer, pgno: number): Buffer => db.subarray((pgno - 1) * PAGE_SIZE, pgno * PAGE_SIZE);

const BASE = [plainPage(1, 0x00), plainPage(2, 0xa2), plainPage(3, 0xa3)];
const plainBase = (): Buffer => Buffer.concat(BASE);

test("decrypts page 1 against a known keystream, keeping its plaintext header bytes 16-23", () => {
    const ciphertext = zeroBodyPage(PAGE1_NONCE);
    ciphertext.writeUInt16BE(PAGE_SIZE, 16);
    ciphertext.set([1, 1, 12, 64, 32, 32], 18);

    const page = decryptLocalStoragePage(KEY, ciphertext, 1);

    const expected = Buffer.from(PAGE1_KEYSTREAM_0_32, "hex");
    assert.equal(page.length, PAGE_SIZE);
    assert.deepEqual(page.subarray(0, 16), expected.subarray(0, 16));
    assert.deepEqual(page.subarray(16, 24), ciphertext.subarray(16, 24));
    assert.deepEqual(page.subarray(24, 32), expected.subarray(24, 32));
    assert.deepEqual(page.subarray(PAGE_SIZE - 12), PAGE1_NONCE);
});

test("decrypts a later page with its own page number in the IV", () => {
    const page = decryptLocalStoragePage(KEY, zeroBodyPage(PAGE3_NONCE), 3);

    assert.equal(page.subarray(4068, 4084).toString("hex"), PAGE3_KEYSTREAM_4068_4084);
    assert.notEqual(
        decryptLocalStoragePage(KEY, zeroBodyPage(PAGE3_NONCE), 4).subarray(4068, 4084).toString("hex"),
        PAGE3_KEYSTREAM_4068_4084
    );
});

test("rejects a page key that is not exactly 32 bytes", () => {
    assert.throws(() => decryptLocalStoragePage(Buffer.alloc(16, 0x11), zeroBodyPage(PAGE3_NONCE), 3), /32-byte/);
});

test("rejects a partial page and an invalid page number", () => {
    assert.throws(() => decryptLocalStoragePage(KEY, Buffer.alloc(PAGE_SIZE - 1), 2), /4096 bytes/);
    assert.throws(() => decryptLocalStoragePage(KEY, zeroBodyPage(PAGE3_NONCE), 0), /page number/);
    assert.throws(() => decryptLocalStoragePage(KEY, zeroBodyPage(PAGE3_NONCE), 1.5), /page number/);
});

test("round-trips a whole database through the inverse transform", () => {
    const plain = [plainPage(1, 0x00), plainPage(2, 0xa2), plainPage(3, 0xa3)];

    assert.deepEqual(decryptLocalStorageDatabase(KEY, encryptDb(plain)), Buffer.concat(plain));
});

test("rejects a database decrypted with the wrong key because page 1 is not a SQLite header", () => {
    const encrypted = encryptDb([plainPage(1, 0x00), plainPage(2, 0xa2)]);

    assert.throws(() => decryptLocalStorageDatabase(Buffer.alloc(32, 0x99), encrypted), /not a SQLite header/);
});

test("rejects an empty, partial-page or wrong-page-size database image", () => {
    const encrypted = encryptDb([plainPage(1, 0x00), plainPage(2, 0xa2)]);
    const wrongPageSize = Buffer.from(encrypted);
    wrongPageSize.writeUInt16BE(1024, 16);

    assert.throws(() => decryptLocalStorageDatabase(KEY, Buffer.alloc(0)), /empty/);
    assert.throws(
        () => decryptLocalStorageDatabase(KEY, encrypted.subarray(0, PAGE_SIZE + 100)),
        /whole number of pages/
    );
    assert.throws(() => decryptLocalStorageDatabase(KEY, wrongPageSize), /page size/);
});

test("WAL: applies a committed frame on top of the decrypted database", () => {
    const newPage2 = plainPage(2, 0xb2);
    const wal = buildWal([{ pgno: 2, page: encryptPage(newPage2, 2), commit: 3 }]);

    const result = applyCommittedWal(KEY, plainBase(), wal);

    assert.deepEqual(pageOf(result, 1), BASE[0]);
    assert.deepEqual(pageOf(result, 2), newPage2);
    assert.deepEqual(pageOf(result, 3), BASE[2]);
});

test("WAL: ignores frames after the last commit frame", () => {
    const committed = plainPage(2, 0xb2);
    const wal = buildWal([
        { pgno: 2, page: encryptPage(committed, 2), commit: 3 },
        { pgno: 2, page: encryptPage(plainPage(2, 0xc2), 2) },
        { pgno: 3, page: encryptPage(plainPage(3, 0xc3), 3) }
    ]);

    const result = applyCommittedWal(KEY, plainBase(), wal);

    assert.deepEqual(pageOf(result, 2), committed);
    assert.deepEqual(pageOf(result, 3), BASE[2]);
});

test("WAL: a commit that grows the database appends the new pages", () => {
    const page4 = plainPage(4, 0xb4);
    const wal = buildWal([{ pgno: 4, page: encryptPage(page4, 4), commit: 4 }]);

    const result = applyCommittedWal(KEY, plainBase(), wal);

    assert.equal(result.length, 4 * PAGE_SIZE);
    assert.deepEqual(pageOf(result, 4), page4);
});

test("WAL: a commit that shrinks the database truncates it to the committed size", () => {
    const wal = buildWal([{ pgno: 1, page: encryptPage(BASE[0], 1), commit: 2 }]);

    const result = applyCommittedWal(KEY, plainBase(), wal);

    assert.equal(result.length, 2 * PAGE_SIZE);
    assert.deepEqual(result, Buffer.concat(BASE.slice(0, 2)));
});

test("WAL: the latest committed transaction wins over earlier ones", () => {
    const latest = plainPage(2, 0xd2);
    const wal = buildWal([
        { pgno: 2, page: encryptPage(plainPage(2, 0xb2), 2), commit: 3 },
        { pgno: 2, page: encryptPage(latest, 2), commit: 3 }
    ]);

    assert.deepEqual(pageOf(applyCommittedWal(KEY, plainBase(), wal), 2), latest);
});

test("WAL: rejects a bad magic number or a page size other than 4096", () => {
    const frames = [{ pgno: 2, page: encryptPage(plainPage(2, 0xb2), 2), commit: 3 }];

    assert.throws(() => applyCommittedWal(KEY, plainBase(), buildWal(frames, { magic: 0x12345678 })), /WAL magic/);
    assert.throws(() => applyCommittedWal(KEY, plainBase(), buildWal(frames, { pageSize: 1024 })), /WAL page size/);
});

test("WAL: a WAL shorter than its header (freshly reset) leaves the database unchanged", () => {
    assert.deepEqual(applyCommittedWal(KEY, plainBase(), Buffer.alloc(0)), plainBase());
    assert.deepEqual(applyCommittedWal(KEY, plainBase(), buildWal([]).subarray(0, 20)), plainBase());
});

test("WAL: stops at the first frame whose salts do not match the header (stale generation)", () => {
    const current = plainPage(2, 0xb2);
    const wal = buildWal([
        { pgno: 2, page: encryptPage(current, 2), commit: 3 },
        { pgno: 3, page: encryptPage(plainPage(3, 0xe3), 3), commit: 3, salts: [SALT1 + 1, SALT2] },
        { pgno: 2, page: encryptPage(plainPage(2, 0xe2), 2), commit: 3 }
    ]);

    const result = applyCommittedWal(KEY, plainBase(), wal);

    assert.deepEqual(pageOf(result, 2), current);
    assert.deepEqual(pageOf(result, 3), BASE[2]);
});

test("WAL: stops at the first frame whose cumulative checksum is wrong", () => {
    const first = plainPage(2, 0xb2);
    const wal = buildWal([
        { pgno: 2, page: encryptPage(first, 2), commit: 3 },
        { pgno: 2, page: encryptPage(plainPage(2, 0xc2), 2), commit: 3 },
        { pgno: 3, page: encryptPage(plainPage(3, 0xc3), 3), commit: 3 }
    ]);
    // Flip one byte of the second frame's page: its checksum and every later one break
    wal[32 + (24 + PAGE_SIZE) + 24 + 100] ^= 0xff;

    const result = applyCommittedWal(KEY, plainBase(), wal);

    assert.deepEqual(pageOf(result, 2), first);
    assert.deepEqual(pageOf(result, 3), BASE[2]);
});

test("WAL: verifies checksums in big-endian order when the magic says so", () => {
    const newPage2 = plainPage(2, 0xb2);
    const wal = buildWal([{ pgno: 2, page: encryptPage(newPage2, 2), commit: 3 }], { magic: WAL_MAGIC_BE });

    assert.deepEqual(pageOf(applyCommittedWal(KEY, plainBase(), wal), 2), newPage2);
});

test("WAL: rejects a header whose own checksum is wrong", () => {
    const wal = buildWal([{ pgno: 2, page: encryptPage(plainPage(2, 0xb2), 2), commit: 3 }]);
    wal.writeUInt32BE((wal.readUInt32BE(24) ^ 1) >>> 0, 24);

    assert.throws(() => applyCommittedWal(KEY, plainBase(), wal), /WAL header checksum/);
});

test("WAL: the parser rejects a checksummed frame that names page 0", () => {
    const wal = buildWal([{ pgno: 0, page: encryptPage(plainPage(2, 0xb2), 2), commit: 3 }]);

    assert.throws(() => parseCommittedWalFrames(wal), /page number/);
});

test("WAL: a partial final frame is ignored and the result is the same as without it", () => {
    const committed = buildWal([{ pgno: 2, page: encryptPage(plainPage(2, 0xb2), 2), commit: 3 }]);
    const torn = Buffer.concat([
        committed,
        buildWal([{ pgno: 3, page: encryptPage(plainPage(3, 0xc3), 3), commit: 3 }]).subarray(32, 32 + 24 + 1000)
    ]);

    const expected = applyCommittedWal(KEY, plainBase(), committed);
    assert.deepEqual(applyCommittedWal(KEY, plainBase(), torn), expected);
    assert.deepEqual(parseCommittedWalFrames(torn)?.frames.length, 1);
});

test("WAL: never modifies the database or WAL buffers it is given", () => {
    const db = plainBase();
    const wal = buildWal([
        { pgno: 2, page: encryptPage(plainPage(2, 0xb2), 2) },
        { pgno: 3, page: encryptPage(plainPage(3, 0xb3), 3), commit: 3 }
    ]);
    const dbBefore = Buffer.from(db);
    const walBefore = Buffer.from(wal);

    const result = applyCommittedWal(KEY, db, wal);

    assert.deepEqual(db, dbBefore);
    assert.deepEqual(wal, walBefore);
    assert.notEqual(result.buffer, db.buffer);
});

test("decrypts a database snapshot and applies its committed WAL", () => {
    const newPage3 = plainPage(3, 0xb3);
    const encryptedDb = encryptDb(BASE);
    const wal = buildWal([
        { pgno: 3, page: encryptPage(newPage3, 3), commit: 3 },
        { pgno: 2, page: encryptPage(plainPage(2, 0xc2), 2) }
    ]);

    const result = decryptLocalStorageSnapshot(KEY, { db: encryptedDb, wal });

    assert.deepEqual(result, Buffer.concat([BASE[0], BASE[1], newPage3]));
    assert.deepEqual(decryptLocalStorageSnapshot(KEY, { db: encryptedDb, wal: null }), plainBase());
});
