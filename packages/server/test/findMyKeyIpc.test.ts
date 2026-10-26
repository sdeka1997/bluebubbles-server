import assert from "node:assert/strict";
import test from "node:test";

import { getFindMyKeysStatus, importFindMyKeys, setFindMyKeyManager } from "../src/server/api/lib/findmy/FindMyKeyIpc";
import { FindMyKeyManager } from "../src/server/api/lib/findmy/FindMyKeyManager";

const fakeManager = (overrides: Partial<FindMyKeyManager> = {}): FindMyKeyManager =>
    ({
        getStatus: async () => ({
            state: "ready",
            keys: { LocalStorage: "ready", FMIP: "ready", FMF: "ready" }
        }),
        importFromDirectory: async () => ({ success: true }),
        ...overrides
    } as unknown as FindMyKeyManager);

test("status comes from the wired key manager", async () => {
    setFindMyKeyManager(fakeManager());

    const response = await getFindMyKeysStatus(true);

    assert.equal(response.supported, true);
    assert.equal(response.status?.state, "ready");
});

test("before macOS 14.4 the status is unsupported and the manager is not consulted", async () => {
    let consulted = false;
    setFindMyKeyManager(
        fakeManager({
            getStatus: async () => {
                consulted = true;
                throw new Error("should not be called");
            }
        })
    );

    const response = await getFindMyKeysStatus(false);

    assert.deepEqual(response, { supported: false, status: null });
    assert.equal(consulted, false);
});

test("status is null until integration wires a key manager", async () => {
    setFindMyKeyManager(null);

    assert.deepEqual(await getFindMyKeysStatus(true), { supported: true, status: null });
});

test("cancelling the folder picker imports nothing", async () => {
    let imported = false;
    setFindMyKeyManager(
        fakeManager({
            importFromDirectory: async () => {
                imported = true;
                return { success: true };
            }
        })
    );

    const response = await importFindMyKeys(async () => null);

    assert.deepEqual(response, { canceled: true, result: null });
    assert.equal(imported, false);
});

test("the picked folder is imported and the single overall result returned", async () => {
    const picked: string[] = [];
    setFindMyKeyManager(
        fakeManager({
            importFromDirectory: async (dir: string) => {
                picked.push(dir);
                return { success: false, file: "FMFDataManager.bplist", reason: "invalid" };
            }
        })
    );

    const response = await importFindMyKeys(async () => "/Users/me/keys");

    assert.deepEqual(picked, ["/Users/me/keys"]);
    assert.deepEqual(response, {
        canceled: false,
        result: { success: false, file: "FMFDataManager.bplist", reason: "invalid" }
    });
});

test("importing before a key manager is wired fails without opening the picker", async () => {
    setFindMyKeyManager(null);
    let opened = false;

    const response = await importFindMyKeys(async () => {
        opened = true;
        return "/Users/me/keys";
    });

    assert.equal(opened, false);
    assert.deepEqual(response, { canceled: false, result: { success: false, file: null, reason: "unavailable" } });
});

test("an unexpected import error becomes an overall failure without its message", async () => {
    setFindMyKeyManager(
        fakeManager({
            importFromDirectory: async () => {
                throw new Error("EACCES deadbeef");
            }
        })
    );

    const response = await importFindMyKeys(async () => "/Users/me/keys");

    assert.deepEqual(response, { canceled: false, result: { success: false, file: null, reason: "error" } });
});
