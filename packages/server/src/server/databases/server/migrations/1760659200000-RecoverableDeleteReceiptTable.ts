import { MigrationInterface, QueryRunner } from "typeorm";

export class RecoverableDeleteReceiptTable1760659200000 implements MigrationInterface {
    name = "RecoverableDeleteReceiptTable1760659200000";

    // Matches what TypeORM synchronize generates for the entity, so fresh (synchronized) and
    // migrated databases end up with an identical schema. IF NOT EXISTS covers the former.
    createRecoverableDeleteReceiptTable =
        `CREATE TABLE IF NOT EXISTS "recoverable_delete_receipt" (` +
        `"attempt_id" text PRIMARY KEY NOT NULL, ` +
        `"chat_guid_hash" text NOT NULL, ` +
        `"state" text NOT NULL DEFAULT ('pending'), ` +
        `"failure_code" text, ` +
        `"created_at" integer NOT NULL, ` +
        `"updated_at" integer NOT NULL, ` +
        `CONSTRAINT "CHK_RECOVERABLE_DELETE_RECEIPT_FAILURE_CODE" ` +
        `CHECK (("state" = 'definitiveFailure') = ("failure_code" IS NOT NULL)), ` +
        `CONSTRAINT "CHK_RECOVERABLE_DELETE_RECEIPT_CHAT_HASH" CHECK (length("chat_guid_hash") = 64), ` +
        `CONSTRAINT "CHK_RECOVERABLE_DELETE_RECEIPT_ATTEMPT_ID" CHECK (length("attempt_id") BETWEEN 16 AND 128), ` +
        `CONSTRAINT "CHK_RECOVERABLE_DELETE_RECEIPT_STATE" ` +
        `CHECK ("state" IN ('pending', 'succeeded', 'definitiveFailure')))`;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(this.createRecoverableDeleteReceiptTable);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "recoverable_delete_receipt"`);
    }
}
