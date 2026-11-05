import { Next } from "koa";
import { RouterContext } from "koa-router";
import { Success } from "../responses/success";
import { ServerError } from "../responses/errors";
import { FindMyInterface } from "@server/api/interfaces/findMyInterface";

/** `?force=true`: relaunch Find My and start a new round even during one (the client's refresh button). */
const isForced = (ctx: RouterContext): boolean => ctx.request.query?.force === "true";

/**
 * Refresh answers carry the round as metadata: `collecting` (new locations follow over the
 * socket) and `startedAt` (ms; a location newer than this is from the round). Reopening a screen
 * during a round joins it, so clients measure their wait from `startedAt`, not from the reopen.
 */
export class FindMyRouter {
    static async refreshDevices(ctx: RouterContext, _: Next) {
        try {
            const locations = await FindMyInterface.refreshDevices(isForced(ctx));
            return new Success(ctx, {
                message: "Successfully refreshed Find My device locations!",
                data: locations,
                metadata: FindMyInterface.round
            }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to refresh Find My device locations!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async refreshFriends(ctx: RouterContext, _: Next) {
        try {
            const locations = await FindMyInterface.refreshFriends(true, isForced(ctx));
            return new Success(ctx, {
                message: "Successfully refreshed Find My friends locations!",
                data: locations,
                metadata: FindMyInterface.round
            }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to refresh Find My friends locations!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async devices(ctx: RouterContext, _: Next) {
        try {
            const data = await FindMyInterface.getDevices();
            return new Success(ctx, { message: "Successfully fetched Find My device locations!", data }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to fetch Find My device locations!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async friends(ctx: RouterContext, _: Next) {
        try {
            const data: any = await FindMyInterface.getFriends();
            return new Success(ctx, { message: "Successfully fetched Find My friends locations!", data }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to fetch Find My friends locations!",
                error: ex?.message ?? ex.toString()
            });
        }
    }
}
