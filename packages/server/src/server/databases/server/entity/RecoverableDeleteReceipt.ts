import { Check, Column, Entity, PrimaryColumn } from "typeorm";

export type RecoverableDeleteReceiptState = "pending" | "succeeded" | "definitiveFailure";

@Entity({ name: "recoverable_delete_receipt" })
@Check("CHK_RECOVERABLE_DELETE_RECEIPT_STATE", `"state" IN ('pending', 'succeeded', 'definitiveFailure')`)
@Check("CHK_RECOVERABLE_DELETE_RECEIPT_ATTEMPT_ID", `length("attempt_id") BETWEEN 16 AND 128`)
@Check("CHK_RECOVERABLE_DELETE_RECEIPT_CHAT_HASH", `length("chat_guid_hash") = 64`)
@Check("CHK_RECOVERABLE_DELETE_RECEIPT_FAILURE_CODE", `("state" = 'definitiveFailure') = ("failure_code" IS NOT NULL)`)
export class RecoverableDeleteReceipt {
    // The primary key is the at-most-once guard: only the request whose insert commits may dispatch
    @PrimaryColumn("text", { name: "attempt_id" })
    attemptId: string;

    // SHA-256 (hex) of the chat GUID, so the receipt is bound to a chat without storing the GUID
    @Column("text", { name: "chat_guid_hash", nullable: false })
    chatGuidHash: string;

    @Column("text", { name: "state", nullable: false, default: "pending" })
    state: RecoverableDeleteReceiptState;

    @Column("text", { name: "failure_code", nullable: true, default: null })
    failureCode: string | null;

    // Epoch milliseconds
    @Column("integer", { name: "created_at", nullable: false })
    createdAt: number;

    // Epoch milliseconds
    @Column("integer", { name: "updated_at", nullable: false })
    updatedAt: number;
}
