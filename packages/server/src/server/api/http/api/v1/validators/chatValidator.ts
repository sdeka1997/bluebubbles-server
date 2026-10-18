import { RouterContext } from "koa-router";
import { Next } from "koa";

import { ValidateInput } from "./index";
import { BadRequest } from "../responses/errors";
import { isValidRecoverableDeleteAttemptId } from "@server/services/RecoverableDeleteReceiptService";

export class ChatValidator {
    static getMessagesRules = {
        with: "string",
        sort: "string|in:DESC,ASC",
        after: "numeric|min:0",
        before: "numeric|min:1",
        offset: "numeric|min:0",
        limit: "numeric|min:1|max:1000"
    };

    static async validateGetMessages(ctx: RouterContext, next: Next) {
        ValidateInput(ctx?.request?.query, ChatValidator.getMessagesRules);
        await next();
    }

    static queryRules = {
        with: "array",
        sort: "string|in:lastmessage",
        offset: "numeric|min:0",
        limit: "numeric|min:1|max:1000"
    };

    static async validateQuery(ctx: RouterContext, next: Next) {
        ValidateInput(ctx?.request?.body, ChatValidator.queryRules);
        await next();
    }

    static updateRules = {
        displayName: "string|min:1"
    };

    static async validateUpdate(ctx: RouterContext, next: Next) {
        ValidateInput(ctx?.request?.body, ChatValidator.updateRules);
        await next();
    }

    static createRules = {
        addresses: "required|array",
        message: "string",
        method: "string|in:apple-script,private-api",
        service: "string|in:iMessage,SMS",
        tempGuid: "string",
        effectId: "string",
        subject: "string",
    };

    static async validateCreate(ctx: RouterContext, next: Next) {
        ValidateInput(ctx?.request?.body, ChatValidator.createRules);
        await next();
    }

    static toggleParticipantRules = {
        address: "required|string"
    };

    static async validateToggleParticipant(ctx: RouterContext, next: Next) {
        ValidateInput(ctx?.request?.body, ChatValidator.toggleParticipantRules);
        await next();
    }

    static async validateGroupChatIcon(ctx: RouterContext, next: Next) {
        const { files } = ctx.request;

        // Make sure the message isn't already in the queue
        const icon = files?.icon as unknown as File;
        if (!icon || icon.size === 0) {
            throw new BadRequest({ error: "Icon not provided or was empty!" });
        }

        await next();
    }

    // Chat GUIDs travel in the body (not the URL) so the request log never records them
    static async validateRecoverableDeleteAttempt(ctx: RouterContext, next: Next) {
        const { chatGuid, attemptId } = (ctx?.request?.body ?? {}) as Record<string, unknown>;
        if (typeof chatGuid !== "string" || chatGuid.length === 0 || chatGuid.length > 1024) {
            throw new BadRequest({ error: "A chatGuid string (1-1024 characters) is required!" });
        }
        if (!isValidRecoverableDeleteAttemptId(attemptId)) {
            throw new BadRequest({ error: "attemptId must be a 16-128 character base64url string!" });
        }

        await next();
    }

    static async validateRecoverableDeleteAttemptId(ctx: RouterContext, next: Next) {
        if (!isValidRecoverableDeleteAttemptId(ctx?.params?.attemptId)) {
            throw new BadRequest({ error: "attemptId must be a 16-128 character base64url string!" });
        }

        await next();
    }
}
