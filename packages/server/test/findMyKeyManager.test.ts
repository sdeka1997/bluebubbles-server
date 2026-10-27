import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FindMyKeyManager, FIND_MY_KEY_FILES } from "../src/server/api/lib/findmy/FindMyKeyManager";

const localStorageKey = Buffer.alloc(32, 0xa1);
const fmipKey = Buffer.concat([Buffer.from("bplist00"), Buffer.alloc(40, 0xb2)]);
const fmfKey = Buffer.concat([Buffer.from("bplist00"), Buffer.alloc(40, 0xc3)]);

const tempRoot = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "bb-findmy-keys-"));

const writeKeySet = (dir: string, files: Partial<Record<string, Buffer | null>> = {}): void => {
    fs.mkdirSync(dir, { recursive: true });
    const set: Record<string, Buffer | null> = {
        [FIND_MY_KEY_FILES.LocalStorage]: localStorageKey,
        [FIND_MY_KEY_FILES.FMIP]: fmipKey,
        [FIND_MY_KEY_FILES.FMF]: fmfKey,
        ...files
    };
    for (const [name, data] of Object.entries(set)) {
        if (data) fs.writeFileSync(path.join(dir, name), data);
    }
};

const readKeySet = (dir: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const name of fs.readdirSync(dir).sort()) {
        out[name] = fs.readFileSync(path.join(dir, name)).toString("hex");
    }
    return out;
};

test("imports a complete, valid key set into the keys directory", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(source);
    const manager = new FindMyKeyManager({ keysDir, validate: () => undefined });

    const result = await manager.importFromDirectory(source);

    assert.deepEqual(result, { success: true });
    assert.deepEqual(readKeySet(keysDir), readKeySet(source));
});

const seedExistingSet = (keysDir: string): Record<string, string> => {
    writeKeySet(keysDir, {
        [FIND_MY_KEY_FILES.LocalStorage]: Buffer.alloc(32, 0x11),
        [FIND_MY_KEY_FILES.FMIP]: Buffer.concat([Buffer.from("bplist00"), Buffer.alloc(16, 0x22)]),
        [FIND_MY_KEY_FILES.FMF]: Buffer.concat([Buffer.from("bplist00"), Buffer.alloc(16, 0x33)])
    });
    return readKeySet(keysDir);
};

test("a source folder missing one key fails the whole import and keeps the old set", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(source, { [FIND_MY_KEY_FILES.FMF]: null });
    const before = seedExistingSet(keysDir);
    const manager = new FindMyKeyManager({ keysDir, validate: () => undefined });

    const result = await manager.importFromDirectory(source);

    assert.equal(result.success, false);
    assert.equal(!result.success && result.file, FIND_MY_KEY_FILES.FMF);
    assert.equal(!result.success && result.reason, "missing");
    assert.deepEqual(readKeySet(keysDir), before);
});

test("a structurally invalid key fails the whole import and keeps the old set", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(source, { [FIND_MY_KEY_FILES.FMF]: Buffer.from("not a plist at all") });
    const before = seedExistingSet(keysDir);
    const manager = new FindMyKeyManager({ keysDir, validate: () => undefined });

    const result = await manager.importFromDirectory(source);

    assert.equal(result.success, false);
    assert.equal(!result.success && result.file, FIND_MY_KEY_FILES.FMF);
    assert.equal(!result.success && result.reason, "invalid");
    assert.deepEqual(readKeySet(keysDir), before);
});

test("a LocalStorage key that is not exactly 32 bytes is invalid", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(source, { [FIND_MY_KEY_FILES.LocalStorage]: Buffer.alloc(33, 0xa1) });
    const manager = new FindMyKeyManager({ keysDir, validate: () => undefined });

    const result = await manager.importFromDirectory(source);

    assert.equal(!result.success && result.file, FIND_MY_KEY_FILES.LocalStorage);
    assert.equal(!result.success && result.reason, "invalid");
    assert.equal(fs.existsSync(path.join(keysDir, FIND_MY_KEY_FILES.LocalStorage)), false);
});

const keyRepresentations = (data: Buffer): string[] => [
    data.toString("hex"),
    data.toString("base64"),
    data.subarray(8).toString("hex")
];

test("a key rejected by the deep-validation hook fails the import without leaking key bytes", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(source);
    const before = seedExistingSet(keysDir);
    const seen: string[] = [];
    const manager = new FindMyKeyManager({
        keysDir,
        validate: (type, data) => {
            seen.push(type);
            if (type === "FMIP") throw new Error(`bad key ${data.toString("hex")}`);
        }
    });

    const result = await manager.importFromDirectory(source);

    assert.equal(!result.success && result.file, FIND_MY_KEY_FILES.FMIP);
    assert.equal(!result.success && result.reason, "invalid");
    assert.ok(seen.includes("FMIP"));
    assert.deepEqual(readKeySet(keysDir), before);
    const serialized = JSON.stringify(result);
    for (const secret of keyRepresentations(fmipKey)) {
        assert.equal(serialized.includes(secret), false);
    }
});

test("an async deep-validation rejection also fails the import", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(source);
    const manager = new FindMyKeyManager({
        keysDir,
        validate: async type => {
            if (type === "LocalStorage") throw new Error("does not decrypt");
        }
    });

    const result = await manager.importFromDirectory(source);

    assert.equal(!result.success && result.file, FIND_MY_KEY_FILES.LocalStorage);
    assert.equal(fs.existsSync(keysDir), false);
});

const mode = (p: string): number => fs.statSync(p).mode & 0o777;

test("imported keys are private: directory 0700, files 0600, even from a world-readable source", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "nested", "FindMyKeys");
    writeKeySet(source);
    for (const name of fs.readdirSync(source)) fs.chmodSync(path.join(source, name), 0o644);
    const manager = new FindMyKeyManager({ keysDir, validate: () => undefined });

    const result = await manager.importFromDirectory(source);

    assert.deepEqual(result, { success: true });
    assert.equal(mode(keysDir), 0o700);
    for (const fileName of Object.values(FIND_MY_KEY_FILES)) {
        assert.equal(mode(path.join(keysDir, fileName)), 0o600, fileName);
    }
});

test("an existing loose keys directory is tightened on import", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(source);
    seedExistingSet(keysDir);
    fs.chmodSync(keysDir, 0o755);
    const manager = new FindMyKeyManager({ keysDir, validate: () => undefined });

    await manager.importFromDirectory(source);

    assert.equal(mode(keysDir), 0o700);
    assert.deepEqual(readKeySet(keysDir), readKeySet(source));
});

test("a failure while swapping the new set into place restores the old set", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(source);
    const before = seedExistingSet(keysDir);
    let faulted = false;
    const manager = new FindMyKeyManager({
        keysDir,
        validate: () => undefined,
        // Fail only the first move into place (the commit); the rollback move must work
        rename: (from, to) => {
            if (to === keysDir && !faulted) {
                faulted = true;
                throw new Error("injected rename fault");
            }
            fs.renameSync(from, to);
        }
    });

    const result = await manager.importFromDirectory(source);

    assert.equal(result.success, false);
    assert.equal(!result.success && result.reason, "commit-failed");
    assert.deepEqual(readKeySet(keysDir), before);
    assert.deepEqual(fs.readdirSync(root).sort(), ["FindMyKeys", "source"]);
});

test("successful and failed imports leave no staging or backup folders behind", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(source);
    seedExistingSet(keysDir);
    const manager = new FindMyKeyManager({ keysDir, validate: () => undefined });

    await manager.importFromDirectory(source);
    fs.rmSync(path.join(source, FIND_MY_KEY_FILES.FMIP));
    await manager.importFromDirectory(source);
    fs.writeFileSync(path.join(source, FIND_MY_KEY_FILES.FMIP), "garbage");
    await manager.importFromDirectory(source);

    assert.deepEqual(fs.readdirSync(root).sort(), ["FindMyKeys", "source"]);
});

test("if the rollback itself fails, the previous set is kept on disk rather than deleted", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(source);
    const before = seedExistingSet(keysDir);
    const manager = new FindMyKeyManager({
        keysDir,
        validate: () => undefined,
        rename: (from, to) => {
            if (to === keysDir) throw new Error("injected rename fault");
            fs.renameSync(from, to);
        }
    });

    const result = await manager.importFromDirectory(source);

    assert.equal(!result.success && result.reason, "commit-failed");
    const survivors = fs
        .readdirSync(root)
        .filter(name => name !== "source")
        .map(name => readKeySet(path.join(root, name)));
    assert.ok(survivors.some(set => JSON.stringify(set) === JSON.stringify(before)));
});

test("loads the committed LocalStorage key and serves later reads from memory", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(source);
    const manager = new FindMyKeyManager({ keysDir, validate: () => undefined });
    await manager.importFromDirectory(source);

    assert.deepEqual(manager.loadLocalStorageKey(), localStorageKey);

    fs.writeFileSync(path.join(keysDir, FIND_MY_KEY_FILES.LocalStorage), Buffer.alloc(32, 0x99));
    assert.deepEqual(manager.loadLocalStorageKey(), localStorageKey);
});

test("a failed import keeps serving the cached keys; a successful one replaces them", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    seedExistingSet(keysDir);
    const oldKey = fs.readFileSync(path.join(keysDir, FIND_MY_KEY_FILES.LocalStorage));
    let rejectFmf = true;
    const manager = new FindMyKeyManager({
        keysDir,
        validate: type => {
            if (type === "FMF" && rejectFmf) throw new Error("rejected");
        }
    });
    assert.deepEqual(manager.loadLocalStorageKey(), oldKey);
    writeKeySet(source);

    await manager.importFromDirectory(source);
    assert.deepEqual(manager.loadLocalStorageKey(), oldKey);

    rejectFmf = false;
    await manager.importFromDirectory(source);
    assert.deepEqual(manager.loadLocalStorageKey(), localStorageKey);
});

test("status reports missing when no keys have been imported", async () => {
    const root = tempRoot();
    const manager = new FindMyKeyManager({ keysDir: path.join(root, "FindMyKeys"), validate: () => undefined });

    const status = await manager.getStatus();

    assert.equal(status.state, "missing");
    assert.deepEqual(status.keys, { LocalStorage: "missing", FMIP: "missing", FMF: "missing" });
});

test("status reports ready when all three imported keys pass validation", async () => {
    const root = tempRoot();
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(keysDir);
    const manager = new FindMyKeyManager({ keysDir, validate: () => undefined });

    const status = await manager.getStatus();

    assert.equal(status.state, "ready");
    assert.deepEqual(status.keys, { LocalStorage: "ready", FMIP: "ready", FMF: "ready" });
});

test("status reports invalid keys without exposing their bytes, and missing beats invalid", async () => {
    const root = tempRoot();
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(keysDir, { [FIND_MY_KEY_FILES.LocalStorage]: Buffer.alloc(31, 0xa1) });
    const manager = new FindMyKeyManager({
        keysDir,
        validate: (type, data) => {
            if (type === "FMIP") throw new Error(data.toString("hex"));
        }
    });

    const status = await manager.getStatus();

    assert.equal(status.state, "invalid");
    assert.deepEqual(status.keys, { LocalStorage: "invalid", FMIP: "invalid", FMF: "ready" });
    const serialized = JSON.stringify(status);
    for (const secret of [...keyRepresentations(fmipKey), ...keyRepresentations(fmfKey)]) {
        assert.equal(serialized.includes(secret), false);
    }

    fs.rmSync(path.join(keysDir, FIND_MY_KEY_FILES.FMF));
    assert.equal((await manager.getStatus()).state, "missing");
});

test("validateKeyFile checks a candidate file without importing it", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(source, { [FIND_MY_KEY_FILES.FMF]: Buffer.from("junk") });
    const manager = new FindMyKeyManager({ keysDir, validate: () => undefined });

    assert.equal(await manager.validateKeyFile("FMIP", path.join(source, FIND_MY_KEY_FILES.FMIP)), true);
    assert.equal(await manager.validateKeyFile("FMF", path.join(source, FIND_MY_KEY_FILES.FMF)), false);
    assert.equal(await manager.validateKeyFile("FMF", path.join(root, "nope.bplist")), false);
    assert.equal(fs.existsSync(keysDir), false);
});

test("a LocalStorage key file of the wrong length loads as null", () => {
    const root = tempRoot();
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(keysDir, { [FIND_MY_KEY_FILES.LocalStorage]: Buffer.alloc(16, 0xa1) });
    const manager = new FindMyKeyManager({ keysDir, validate: () => undefined });

    assert.equal(manager.loadLocalStorageKey(), null);
});

test("cache keys are extracted from the imported bplist by the injected extractor and cached", async () => {
    const root = tempRoot();
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(keysDir);
    const extracted = Buffer.alloc(32, 0x5c);
    const calls: string[] = [];
    const manager = new FindMyKeyManager({
        keysDir,
        validate: () => undefined,
        extractCacheKey: (type, data) => {
            calls.push(type);
            return data.equals(fmipKey) ? extracted : null;
        }
    });

    assert.deepEqual(await manager.loadCacheKey("FMIP"), extracted);
    assert.deepEqual(await manager.loadCacheKey("FMIP"), extracted);
    assert.equal(await manager.loadCacheKey("FMF"), null);
    assert.deepEqual(calls, ["FMIP", "FMF"]);
});

test("a throwing extractor loads as null", async () => {
    const root = tempRoot();
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(keysDir);
    const manager = new FindMyKeyManager({
        keysDir,
        validate: () => undefined,
        extractCacheKey: () => {
            throw new Error("unparseable");
        }
    });

    assert.equal(await manager.loadCacheKey("FMF"), null);
});

test("an unreadable source entry fails the import cleanly instead of throwing", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    writeKeySet(source, { [FIND_MY_KEY_FILES.FMIP]: null });
    fs.mkdirSync(path.join(source, FIND_MY_KEY_FILES.FMIP));
    const before = seedExistingSet(keysDir);
    const manager = new FindMyKeyManager({ keysDir, validate: () => undefined });

    const result = await manager.importFromDirectory(source);

    assert.equal(!result.success && result.file, FIND_MY_KEY_FILES.FMIP);
    assert.equal(!result.success && result.reason, "invalid");
    assert.deepEqual(readKeySet(keysDir), before);
    assert.deepEqual(fs.readdirSync(root).sort(), ["FindMyKeys", "source"]);
});

test("an oversized key file is rejected without reaching the deep-validation hook", async () => {
    const root = tempRoot();
    const source = path.join(root, "source");
    const keysDir = path.join(root, "FindMyKeys");
    const huge = Buffer.concat([Buffer.from("bplist00"), Buffer.alloc(65 * 1024)]);
    writeKeySet(source, { [FIND_MY_KEY_FILES.FMF]: huge });
    let deepChecked = false;
    const manager = new FindMyKeyManager({
        keysDir,
        validate: type => {
            if (type === "FMF") deepChecked = true;
        }
    });

    const result = await manager.importFromDirectory(source);

    assert.equal(!result.success && result.reason, "invalid");
    assert.equal(deepChecked, false);
});
