import { createHash } from "node:crypto";

export type RecoverableDeleteReceiptState = "pending" | "succeeded" | "definitiveFailure";

export interface RecoverableDeleteReceipt {
    attemptId: string;
    chatBinding: string;
    state: RecoverableDeleteReceiptState;
    createdAt: number;
    updatedAt: number;
    version: 1;
}

export interface RecoverableDeleteReceiptStore {
    find(attemptId: string): Promise<RecoverableDeleteReceipt | null>;
    createPending(receipt: RecoverableDeleteReceipt): Promise<boolean>;
    transition(
        attemptId: string,
        state: Exclude<RecoverableDeleteReceiptState, "pending">,
        updatedAt: number
    ): Promise<void>;
}

export class ReceiptBindingError extends Error {}
export class ReceiptNotFoundError extends Error {}

const ATTEMPT_ID = /^[A-Za-z0-9_-]{16,128}$/u;

export class RecoverableDeleteReceiptService {
    private readonly locks = new Map<string, Promise<void>>();

    constructor(
        private readonly store: RecoverableDeleteReceiptStore,
        private readonly invokeHelper: (chatGuid: string) => Promise<"succeeded" | "definitiveFailure">,
        private readonly now: () => number = Date.now
    ) {}

    private static validateAttemptId(attemptId: string) {
        if (!ATTEMPT_ID.test(attemptId)) throw new Error("Invalid attemptId");
    }

    private static binding(chatGuid: string) {
        return createHash("sha256").update(chatGuid, "utf8").digest("hex");
    }

    private static assertBinding(receipt: RecoverableDeleteReceipt, chatGuid: string) {
        if (receipt.chatBinding !== RecoverableDeleteReceiptService.binding(chatGuid)) {
            throw new ReceiptBindingError("attemptId is already bound to another chat");
        }
    }

    private async serialized<T>(attemptId: string, action: () => Promise<T>): Promise<T> {
        const previous = this.locks.get(attemptId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => {
            release = resolve;
        });
        const queued = previous.then(() => current);
        this.locks.set(attemptId, queued);
        await previous;
        try {
            return await action();
        } finally {
            release();
            if (this.locks.get(attemptId) === queued) this.locks.delete(attemptId);
        }
    }

    async submit(attemptId: string, chatGuid: string): Promise<RecoverableDeleteReceipt> {
        RecoverableDeleteReceiptService.validateAttemptId(attemptId);
        return this.serialized(attemptId, async () => {
            const existing = await this.store.find(attemptId);
            if (existing) {
                RecoverableDeleteReceiptService.assertBinding(existing, chatGuid);
                return existing;
            }

            const timestamp = this.now();
            const pending: RecoverableDeleteReceipt = {
                attemptId,
                chatBinding: RecoverableDeleteReceiptService.binding(chatGuid),
                state: "pending",
                createdAt: timestamp,
                updatedAt: timestamp,
                version: 1
            };
            const created = await this.store.createPending(pending);
            if (!created) {
                const raced = await this.store.find(attemptId);
                if (!raced) throw new Error("Receipt creation raced without a durable receipt");
                RecoverableDeleteReceiptService.assertBinding(raced, chatGuid);
                return raced;
            }

            let outcome: "succeeded" | "definitiveFailure";
            try {
                outcome = await this.invokeHelper(chatGuid);
            } catch (_) {
                return pending;
            }
            await this.store.transition(attemptId, outcome, this.now());
            return (await this.store.find(attemptId)) ?? pending;
        });
    }

    async status(attemptId: string, chatGuid: string): Promise<RecoverableDeleteReceipt> {
        RecoverableDeleteReceiptService.validateAttemptId(attemptId);
        const receipt = await this.store.find(attemptId);
        if (!receipt) throw new ReceiptNotFoundError("Receipt not found");
        RecoverableDeleteReceiptService.assertBinding(receipt, chatGuid);
        return receipt;
    }
}
