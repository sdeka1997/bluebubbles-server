import { createHash } from "crypto";
import { DataSource } from "typeorm";
import {
    RecoverableDeleteReceipt,
    RecoverableDeleteReceiptState
} from "../databases/server/entity/RecoverableDeleteReceipt";

// Client-generated base64url token without padding, 16-128 characters
export const RECOVERABLE_DELETE_ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const isValidRecoverableDeleteAttemptId = (value: unknown): value is string =>
    typeof value === "string" && RECOVERABLE_DELETE_ATTEMPT_ID_PATTERN.test(value);

export const hashRecoverableDeleteChatGuid = (chatGuid: string): string =>
    createHash("sha256").update(chatGuid, "utf8").digest("hex");

export type RecoverableDeletePreDispatchCode = "privateApiUnavailable" | "unsupportedMacOS";

/**
 * Thrown only by checks that run before anything is written to the Private API helper,
 * so the deletion provably never reached it. Every other failure is ambiguous.
 */
export class RecoverableDeletePreDispatchError extends Error {
    readonly preDispatch = true;

    readonly code: RecoverableDeletePreDispatchCode;

    constructor(code: RecoverableDeletePreDispatchCode, message: string) {
        super(message);
        this.name = "RecoverableDeletePreDispatchError";
        this.code = code;
    }
}

export class DeleteAttemptConflictError extends Error {
    constructor() {
        super("Delete attempt is bound to a different chat");
        this.name = "DeleteAttemptConflictError";
    }
}

export interface RecoverableDeleteReceiptView {
    attemptId: string;
    state: RecoverableDeleteReceiptState;
    failureCode: string | null;
    createdAt: number;
    updatedAt: number;
}

const toView = (receipt: RecoverableDeleteReceipt): RecoverableDeleteReceiptView => ({
    attemptId: receipt.attemptId,
    state: receipt.state,
    failureCode: receipt.failureCode,
    createdAt: Number(receipt.createdAt),
    updatedAt: Number(receipt.updatedAt)
});

/**
 * Records recoverable chat deletes so a client can learn whether an attempt was dispatched.
 * Receipts never expire and are never retried; ambiguous outcomes stay pending.
 * Kept free of the Electron-bound server singleton so it can run against any DataSource.
 */
export class RecoverableDeleteReceiptService {
    private readonly db: DataSource;

    private readonly log: (message: string) => void;

    constructor(db: DataSource, log: (message: string) => void = () => undefined) {
        this.db = db;
        this.log = log;
    }

    async get(attemptId: string): Promise<RecoverableDeleteReceiptView | null> {
        const receipt = await this.db.getRepository(RecoverableDeleteReceipt).findOneBy({ attemptId });
        return receipt ? toView(receipt) : null;
    }

    async submit(
        attemptId: string,
        chatGuid: string,
        dispatch: () => Promise<unknown>
    ): Promise<RecoverableDeleteReceiptView> {
        const repository = this.db.getRepository(RecoverableDeleteReceipt);
        const chatGuidHash = hashRecoverableDeleteChatGuid(chatGuid);
        const now = Date.now();
        const pending: RecoverableDeleteReceipt = {
            attemptId,
            chatGuidHash,
            state: "pending",
            failureCode: null,
            createdAt: now,
            updatedAt: now
        };

        // The pending row must be committed before dispatch. Losing the insert race (or any
        // insert failure) means this request never dispatches.
        try {
            await repository.insert(pending);
        } catch (ex: any) {
            const existing = await repository.findOneBy({ attemptId });
            if (!existing) throw ex;
            if (existing.chatGuidHash !== chatGuidHash) throw new DeleteAttemptConflictError();
            return toView(existing);
        }

        let outcome: Pick<RecoverableDeleteReceipt, "state" | "failureCode"> = null;
        try {
            await dispatch();
            outcome = { state: "succeeded", failureCode: null };
        } catch (ex: any) {
            if (ex instanceof RecoverableDeletePreDispatchError && ex.preDispatch === true) {
                outcome = { state: "definitiveFailure", failureCode: ex.code };
            } else {
                this.log(`Recoverable delete attempt ${attemptId} has an unknown outcome; leaving it pending`);
            }
        }

        if (!outcome) return toView(pending);

        const updatedAt = Date.now();
        try {
            await repository.update({ attemptId, state: "pending" }, { ...outcome, updatedAt });
        } catch {
            this.log(`Failed to record ${outcome.state} for delete attempt ${attemptId}; leaving it pending`);
            return toView(pending);
        }

        return toView({ ...pending, ...outcome, updatedAt });
    }
}
