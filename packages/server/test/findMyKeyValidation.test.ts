import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import plist from "plist";

import { FIND_MY_KEY_FILES } from "../src/server/api/lib/findmy/FindMyKeyManager";
import { createFindMyKeyManager } from "../src/server/api/lib/findmy/FindMyKeyValidation";
import { sealedCacheFile } from "./findMyCacheFixtures";
import { encryptDb, KEY as LOCAL_STORAGE_KEY, plainPage } from "./findMyLocalStorageFixtures";

const FMIP_KEY = Buffer.alloc(32, 0x44);
const FMF_KEY = Buffer.alloc(32, 0x55);

/** A DataManager key file as findmy-key-extractor writes it: symmetricKey -> key -> data. */
const keyPlist = (key: Buffer): Buffer => Buffer.from(plist.build({ symmetricKey: { key: { data: key } } } as any));

/**
 * A scratch home with Apple's encrypted caches (each optional) and a folder of candidate keys.
 */
const setup = ({
    keys = {},
    caches = { localStorage: true, devices: true, friends: true }
}: {
    keys?: Partial<Record<keyof typeof FIND_MY_KEY_FILES, Buffer>>;
    caches?: { localStorage?: boolean; devices?: boolean; friends?: boolean };
} = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "findmy-key-validation-"));
    const paths = {
        localStorageDbPath: path.join(root, "LocalStorage.db"),
        fmipCacheDir: path.join(root, "fmipcore"),
        fmfCacheDir: path.join(root, "fmfcore")
    };
    fs.mkdirSync(paths.fmipCacheDir);
    fs.mkdirSync(paths.fmfCacheDir);
    if (caches.localStorage) {
        fs.writeFileSync(paths.localStorageDbPath, encryptDb([plainPage(1, 0x00), plainPage(2, 0xa2)]));
    }
    if (caches.devices) fs.writeFileSync(path.join(paths.fmipCacheDir, "Devices.data"), sealedCacheFile([], FMIP_KEY));
    if (caches.friends) {
        fs.writeFileSync(
            path.join(paths.fmfCacheDir, "FriendCacheData.data"),
            sealedCacheFile({ following: [] }, FMF_KEY)
        );
    }

    const source = path.join(root, "source");
    fs.mkdirSync(source);
    const keySet = { LocalStorage: LOCAL_STORAGE_KEY, FMIP: keyPlist(FMIP_KEY), FMF: keyPlist(FMF_KEY), ...keys };
    for (const [type, data] of Object.entries(keySet)) {
        fs.writeFileSync(path.join(source, FIND_MY_KEY_FILES[type as keyof typeof FIND_MY_KEY_FILES]), data);
    }

    const manager = createFindMyKeyManager(path.join(root, "FindMyKeys"), paths);
    return { manager, source, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
};

test("accepts keys that decrypt the caches on disk and serves the extracted cache keys", async () => {
    const { manager, source, cleanup } = setup();
    try {
        assert.deepEqual(await manager.importFromDirectory(source), { success: true });

        assert.equal((await manager.getStatus()).state, "ready");
        assert.deepEqual(manager.loadLocalStorageKey(), LOCAL_STORAGE_KEY);
        assert.deepEqual(await manager.loadCacheKey("FMIP"), FMIP_KEY);
        assert.deepEqual(await manager.loadCacheKey("FMF"), FMF_KEY);
    } finally {
        cleanup();
    }
});

test("rejects a key that does not decrypt the matching cache, keeping the previous set", async () => {
    const wrong = Buffer.alloc(32, 0x99);
    const cases: Array<[keyof typeof FIND_MY_KEY_FILES, Buffer]> = [
        ["LocalStorage", wrong],
        ["FMIP", keyPlist(wrong)],
        ["FMF", keyPlist(wrong)],
        // A bplist with no 32-byte symmetric key in it
        ["FMIP", Buffer.from(plist.build({ symmetricKey: { key: { data: Buffer.alloc(16) } } } as any))],
        ["FMF", Buffer.from(plist.build({ somethingElse: 1 } as any))]
    ];
    for (const [type, data] of cases) {
        const { manager, source, cleanup } = setup({ keys: { [type]: data } });
        try {
            const result = await manager.importFromDirectory(source);

            assert.deepEqual(result, { success: false, file: FIND_MY_KEY_FILES[type], reason: "invalid" }, type);
            assert.equal(manager.loadLocalStorageKey(), null);
        } finally {
            cleanup();
        }
    }
});

test("accepts structurally valid keys when Find My has not written the caches yet", async () => {
    const { manager, source, cleanup } = setup({ caches: {} });
    try {
        assert.deepEqual(await manager.importFromDirectory(source), { success: true });
    } finally {
        cleanup();
    }

    // ...but a cache key bplist with no extractable key is still rejected
    const noKey = setup({ caches: {}, keys: { FMF: Buffer.from(plist.build({ somethingElse: 1 } as any)) } });
    try {
        assert.equal((await noKey.manager.importFromDirectory(noKey.source)).success, false);
    } finally {
        noKey.cleanup();
    }
});
