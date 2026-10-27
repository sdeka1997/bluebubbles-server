import { Server } from "@server";
import {
    TransactionPromise,
    TransactionResult,
    TransactionType
} from "@server/managers/transactionManager/transactionPromise";
import { PrivateApiAction } from ".";
import { ChatLookup, withChatLookup } from "../chatLookup";

export class PrivateApiAttachment extends PrivateApiAction {
    tag = "PrivateApiAttachment";

    async send({
        chatGuid,
        filePath,
        isAudioMessage = false,
        attributedBody = null,
        subject = null,
        effectId = null,
        selectedMessageGuid = null,
        partIndex = 0,
        chatLookup = null
    }: {
        chatGuid: string;
        filePath: string;
        isAudioMessage?: boolean;
        attributedBody?: Record<string, any> | null;
        subject?: string;
        effectId?: string;
        selectedMessageGuid?: string;
        partIndex?: number;
        chatLookup?: ChatLookup;
    }): Promise<TransactionResult> {
        const action = "send-attachment";
        this.throwForNoMissingFields(action, [chatGuid, filePath]);
        const request = new TransactionPromise(TransactionType.ATTACHMENT);
        return this.sendApiMessage(
            action,
            withChatLookup(
                {
                    chatGuid,
                    filePath,
                    isAudioMessage: isAudioMessage ? 1 : 0,
                    attributedBody,
                    subject,
                    effectId,
                    selectedMessageGuid,
                    partIndex
                },
                chatLookup
            ),
            request
        );
    }

    async downloadPurged(guid: string): Promise<TransactionResult> {
        const action = "download-purged-attachment";
        this.throwForNoMissingFields(action, [guid]);
        return this.sendApiMessage(action, { attachmentGuid: guid });
    }
}
