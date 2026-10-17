import { MigrationInterface, QueryRunner } from "typeorm";

export class RecoverableDeleteReceiptTable1760716800000 implements MigrationInterface {
    name = "RecoverableDeleteReceiptTable1760716800000";

    async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            "CREATE TABLE IF NOT EXISTS recoverable_delete_receipt (attempt_id text PRIMARY KEY NOT NULL, chat_binding text NOT NULL, state text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL, version integer NOT NULL DEFAULT (1))"
        );
    }

    async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query("DROP TABLE IF EXISTS recoverable_delete_receipt");
    }
}
