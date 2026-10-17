import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity({ name: "recoverable_delete_receipt" })
export class RecoverableDeleteReceiptEntity {
    @PrimaryColumn("text", { name: "attempt_id" })
    attemptId: string;

    @Column("text", { name: "chat_binding" })
    chatBinding: string;

    @Column("text", { name: "state" })
    state: "pending" | "succeeded" | "definitiveFailure";

    @Column("integer", { name: "created_at" })
    createdAt: number;

    @Column("integer", { name: "updated_at" })
    updatedAt: number;

    @Column("integer", { name: "version", default: 1 })
    version: 1;
}
