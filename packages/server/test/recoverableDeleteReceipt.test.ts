import assert from "node:assert/strict";
import test from "node:test";

import {
    RecoverableDeleteReceiptService,
    RecoverableDeleteReceiptStore,
    ReceiptBindingError,
    type RecoverableDeleteReceipt
} from "../src/server/services/recoverableDeleteReceiptService";

class MemoryStore implements RecoverableDeleteReceiptStore {
    constructor(readonly receipts = new Map<string, RecoverableDeleteReceipt>()) {}
    failCreate = false;

    async find(attemptId: string) {
        const value = this.receipts.get(attemptId);
        return value ? { ...value } : null;
    }

    async createPending(receipt: RecoverableDeleteReceipt) {
        if (this.failCreate) throw new Error("disk unavailable");
        if (this.receipts.has(receipt.attemptId)) return false;
        this.receipts.set(receipt.attemptId, { ...receipt });
        return true;
    }

    async transition(attemptId: string, state: "succeeded" | "definitiveFailure", updatedAt: number) {
        const current = this.receipts.get(attemptId);
        if (!current || current.state !== "pending") return;
        this.receipts.set(attemptId, { ...current, state, updatedAt });
    }
}

const ATTEMPT = "MDEyMzQ1Njc4OWFiY2RlZg";

test("persists pending before invoking helper and persistence failure invokes no helper", async () => {
    const store = new MemoryStore();
    store.failCreate = true;
    let calls = 0;
    const service = new RecoverableDeleteReceiptService(store, async () => {
        calls += 1;
        return "succeeded";
    });

    await assert.rejects(service.submit(ATTEMPT, "chat-a"), /disk unavailable/);
    assert.equal(calls, 0);
});

test("duplicate submit executes once and survives service reconstruction", async () => {
    const durableStorage = new Map<string, RecoverableDeleteReceipt>();
    let calls = 0;
    const helper = async () => {
        calls += 1;
        return "succeeded" as const;
    };
    const first = new RecoverableDeleteReceiptService(new MemoryStore(durableStorage), helper);
    assert.equal((await first.submit(ATTEMPT, "chat-a")).state, "succeeded");

    const afterRestart = new RecoverableDeleteReceiptService(new MemoryStore(durableStorage), helper);
    assert.equal((await afterRestart.submit(ATTEMPT, "chat-a")).state, "succeeded");
    assert.equal(calls, 1);
});

test("same attempt bound to another chat is definitively rejected", async () => {
    const store = new MemoryStore();
    const service = new RecoverableDeleteReceiptService(store, async () => "succeeded");
    await service.submit(ATTEMPT, "chat-a");
    await assert.rejects(service.submit(ATTEMPT, "chat-b"), ReceiptBindingError);
    await assert.rejects(service.status(ATTEMPT, "chat-b"), ReceiptBindingError);
});

test("classifies success and definitive failure but keeps timeout pending", async () => {
    for (const [suffix, outcome, expected] of [
        ["A", "succeeded", "succeeded"],
        ["B", "definitiveFailure", "definitiveFailure"]
    ] as const) {
        const service = new RecoverableDeleteReceiptService(new MemoryStore(), async () => outcome);
        assert.equal((await service.submit(`${ATTEMPT}${suffix}`, "chat-a")).state, expected);
    }

    const timeoutStore = new MemoryStore();
    const timeout = new RecoverableDeleteReceiptService(timeoutStore, async () => {
        throw new Error("timeout");
    });
    assert.equal((await timeout.submit(`${ATTEMPT}C`, "chat-a")).state, "pending");
    assert.equal((await timeout.status(`${ATTEMPT}C`, "chat-a")).state, "pending");
});

test("concurrent duplicate submissions invoke helper exactly once", async () => {
    const store = new MemoryStore();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    let calls = 0;
    const service = new RecoverableDeleteReceiptService(store, async () => {
        calls += 1;
        await gate;
        return "succeeded";
    });

    const first = service.submit(ATTEMPT, "chat-a");
    const second = service.submit(ATTEMPT, "chat-a");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    assert.equal((await first).state, "succeeded");
    assert.equal((await second).state, "succeeded");
    assert.equal(calls, 1);
});

test("crash after external effect leaves pending and duplicate never resubmits", async () => {
    const store = new MemoryStore();
    let effects = 0;
    const crashing = new RecoverableDeleteReceiptService(store, async () => {
        effects += 1;
        throw new Error("process died before success record");
    });
    assert.equal((await crashing.submit(ATTEMPT, "chat-a")).state, "pending");

    const restarted = new RecoverableDeleteReceiptService(store, async () => {
        effects += 1;
        return "succeeded";
    });
    assert.equal((await restarted.submit(ATTEMPT, "chat-a")).state, "pending");
    assert.equal(effects, 1);
});

test("validates bounded opaque attempt ids", async () => {
    const service = new RecoverableDeleteReceiptService(new MemoryStore(), async () => "succeeded");
    for (const invalid of ["short", "contains space value", "x".repeat(129)]) {
        await assert.rejects(service.submit(invalid, "chat-a"), /attemptId/);
    }
});
