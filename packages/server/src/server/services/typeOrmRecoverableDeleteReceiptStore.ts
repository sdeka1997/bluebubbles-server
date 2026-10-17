import { Repository } from "typeorm";

import { RecoverableDeleteReceiptEntity } from "@server/databases/server/entity/RecoverableDeleteReceipt";
import {
    RecoverableDeleteReceipt,
    RecoverableDeleteReceiptState,
    RecoverableDeleteReceiptStore
} from "./recoverableDeleteReceiptService";

export class TypeOrmRecoverableDeleteReceiptStore implements RecoverableDeleteReceiptStore {
    constructor(private readonly repository: Repository<RecoverableDeleteReceiptEntity>) {}

    async find(attemptId: string): Promise<RecoverableDeleteReceipt | null> {
        return await this.repository.findOneBy({ attemptId });
    }

    async createPending(receipt: RecoverableDeleteReceipt): Promise<boolean> {
        try {
            await this.repository.insert(this.repository.create(receipt));
            return true;
        } catch (error: any) {
            if (error?.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error?.code === "SQLITE_CONSTRAINT") return false;
            throw error;
        }
    }

    async transition(
        attemptId: string,
        state: Exclude<RecoverableDeleteReceiptState, "pending">,
        updatedAt: number
    ): Promise<void> {
        await this.repository.update({ attemptId, state: "pending" }, { state, updatedAt });
    }
}
