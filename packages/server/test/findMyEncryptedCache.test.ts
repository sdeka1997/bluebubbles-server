import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import plist from "plist";

import {
    decryptCacheBuffer,
    decryptChaCha20Poly1305,
    MAX_FIND_MY_CACHE_BYTES
} from "../src/server/api/lib/findmy/decrypt/cache";
import {
    extractSymmetricKey,
    MAX_PLIST_BYTES,
    parsePlistBuffer,
    parsePlistFile
} from "../src/server/api/lib/findmy/decrypt/plistUtils";
import { readFmfRosterData } from "../src/server/api/lib/findmy/decrypt/fmfReader";
import { CACHE_KEY as KEY, cacheFile, seal } from "./findMyCacheFixtures";

// Synthetic FriendCacheData payload as a binary plist (generated with Python's plistlib):
// { contacts: { "friend-1~": { displayName: "Dad", shortName: "$null" } },
//   following: [{ id: "friend-1", invitationAcceptedHandles: ["dad@example.com"],
//                 nested: ["$null", { deep: "$null" }] }],
//   myInfo: { emails: ["owner@example.com"] } }
const FMF_PAYLOAD = Buffer.from(
    "YnBsaXN0MDDTAQIDBAsWWGNvbnRhY3RzWWZvbGxvd2luZ1ZteUluZm/RBQZZZnJpZW5kLTF+0gcICQpbZGlzcGxheU5hbWVZc2hvcnROYW1lU0RhZFUkbnVsbKEM0w0ODxARE1JpZF8QGWludml0YXRpb25BY2NlcHRlZEhhbmRsZXNWbmVzdGVkWGZyaWVuZC0xoRJfEA9kYWRAZXhhbXBsZS5jb22iChTRFQpUZGVlcNEXGFZlbWFpbHOhGV8QEW93bmVyQGV4YW1wbGUuY29tCA8YIiksNjtHUVVbXWRng4qTlaeqrbK1vL4AAAAAAAABAQAAAAAAAAAaAAAAAAAAAAAAAAAAAAAA0g==",
    "base64"
);

test("decrypts a ChaCha20-Poly1305 envelope", () => {
    const envelope = seal(Buffer.from("find my friends"));

    assert.equal(envelope.length, 12 + 15 + 16);
    assert.deepEqual(decryptChaCha20Poly1305(envelope, KEY), Buffer.from("find my friends"));
});

test("rejects a payload sealed with a different key as an authentication failure", () => {
    const envelope = seal(Buffer.from("find my friends"), Buffer.alloc(32, 0x33));

    assert.throws(() => decryptChaCha20Poly1305(envelope, KEY), /authentication failed/);
});

test("rejects an envelope too short to hold a nonce and tag", () => {
    assert.throws(() => decryptChaCha20Poly1305(Buffer.alloc(27), KEY), /too short/);
});

test("rejects a key that is not exactly 32 bytes before decrypting", () => {
    const envelope = seal(Buffer.from("find my friends"));

    assert.throws(() => decryptChaCha20Poly1305(envelope, Buffer.alloc(16, 0x11)), /32-byte/);
    assert.throws(() => decryptChaCha20Poly1305(envelope, Buffer.alloc(33, 0x11)), /32-byte/);
});

test("decrypts a cache file and parses the binary plist inside it", async () => {
    const result = await decryptCacheBuffer(cacheFile(seal(FMF_PAYLOAD)), KEY);

    assert.equal(result.contacts["friend-1~"].displayName, "Dad");
    assert.deepEqual(result.following[0].invitationAcceptedHandles, ["dad@example.com"]);
    assert.deepEqual(result.myInfo, { emails: ["owner@example.com"] });
});

test('recursively replaces Apple\'s "$null" placeholder with null', async () => {
    const result = await decryptCacheBuffer(cacheFile(seal(FMF_PAYLOAD)), KEY);

    assert.equal(result.contacts["friend-1~"].shortName, null);
    assert.deepEqual(result.following[0].nested, [null, { deep: null }]);
});

test("rejects a cache file whose wrapper has no encryptedData blob", async () => {
    const wrapper = Buffer.from(plist.build({ somethingElse: "x" } as any));

    await assert.rejects(async () => decryptCacheBuffer(wrapper, KEY), /no encryptedData/);
});

test("rejects a payload whose plaintext is a malformed plist", async () => {
    const truncated = FMF_PAYLOAD.subarray(0, FMF_PAYLOAD.length - 20);

    await assert.rejects(async () => decryptCacheBuffer(cacheFile(seal(truncated)), KEY), /malformed plist/);
    await assert.rejects(
        async () => decryptCacheBuffer(cacheFile(seal(Buffer.from("not a plist"))), KEY),
        /malformed plist/
    );
});

test("refuses an implausibly large cache file before parsing it", async () => {
    const oversized = Buffer.alloc(MAX_FIND_MY_CACHE_BYTES + 1);

    await assert.rejects(async () => decryptCacheBuffer(oversized, KEY), /too large/);
});

test("parsePlistBuffer refuses non-buffer and oversized input before parsing", () => {
    assert.throws(() => parsePlistBuffer("bplist00" as any), /expected a Buffer/);
    assert.throws(() => parsePlistBuffer(Buffer.alloc(MAX_PLIST_BYTES + 1)), /too large/);
});

test("extractSymmetricKey reads the nested 32-byte key and rejects anything else", () => {
    const key = Buffer.alloc(32, 0x44);

    assert.deepEqual(extractSymmetricKey({ symmetricKey: { key: { data: key } } }), key);
    assert.deepEqual(extractSymmetricKey({ symmetricKey: key.toString("base64") }), key);
    assert.equal(extractSymmetricKey({ symmetricKey: { key: { data: Buffer.alloc(16) } } }), null);
    assert.equal(extractSymmetricKey({ symmetricKey: 42 }), null);
    assert.equal(extractSymmetricKey(null), null);
});

test("parsePlistFile reads a regular file but refuses symlinks and directories", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "findmy-plist-test-"));
    try {
        const file = path.join(dir, "key.plist");
        fs.writeFileSync(file, plist.build({ symmetricKey: "abc" } as any));
        fs.symlinkSync(file, path.join(dir, "link.plist"));

        assert.deepEqual(parsePlistFile(file), { symmetricKey: "abc" });
        assert.throws(() => parsePlistFile(path.join(dir, "link.plist")), /not a regular file/);
        assert.throws(() => parsePlistFile(dir), /not a regular file/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("readFmfRosterData returns the complete decrypted FMF payload, not just names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "findmy-fmf-test-"));
    try {
        fs.writeFileSync(path.join(dir, "FriendCacheData.data"), cacheFile(seal(FMF_PAYLOAD)));

        const data = readFmfRosterData(KEY, dir);

        assert.deepEqual(Object.keys(data).sort(), ["contacts", "following", "myInfo"]);
        assert.deepEqual(data.following[0], {
            id: "friend-1",
            invitationAcceptedHandles: ["dad@example.com"],
            nested: [null, { deep: null }]
        });
        assert.deepEqual(data.contacts["friend-1~"], { displayName: "Dad", shortName: null });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("readFmfRosterData refuses a symlinked cache file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "findmy-fmf-test-"));
    try {
        const real = path.join(dir, "elsewhere.data");
        fs.writeFileSync(real, cacheFile(seal(FMF_PAYLOAD)));
        fs.symlinkSync(real, path.join(dir, "FriendCacheData.data"));

        assert.throws(() => readFmfRosterData(KEY, dir), /not a regular file/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
