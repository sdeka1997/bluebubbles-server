import { Next } from "koa";
import { RouterContext } from "koa-router";
import { Success } from "../responses/success";
import { BadRequest, NotFound, ServerError } from "../responses/errors";
import { FindMyInterface } from "@server/api/interfaces/findMyInterface";
import {
    findMyLiveTrackingFailureStatus,
    findMyLiveTrackingHandle
} from "@server/api/lib/findmy/FindMyLiveTrackingRequest";

/**
 * Refresh answers carry what the server has now. Find My on the Mac runs while a client's map is
 * open (the findmy-screen socket event) and its new locations follow over the socket.
 */
export class FindMyRouter {
    static async refreshDevices(ctx: RouterContext, _: Next) {
        try {
            const locations = await FindMyInterface.refreshDevices();
            return new Success(ctx, {
                message: "Successfully refreshed Find My device locations!",
                data: locations
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
            const locations = await FindMyInterface.refreshFriends();
            return new Success(ctx, {
                message: "Successfully refreshed Find My friends locations!",
                data: locations
            }).send();
        } catch (ex: any) {
            throw new ServerError({
                message: "Failed to refresh Find My friends locations!",
                error: ex?.message ?? ex.toString()
            });
        }
    }

    static async liveTracking(ctx: RouterContext, _: Next) {
        let handle: string | null;
        try {
            handle = findMyLiveTrackingHandle(ctx.request.body);
        } catch (ex: any) {
            throw new BadRequest({ error: ex?.message ?? ex.toString() });
        }
        try {
            const active = await FindMyInterface.setTrackedFriend(handle);
            return new Success(ctx, {
                message: active ? "Started Find My live tracking" : "Find My live tracking is off",
                data: { active, handle: active ? handle : null }
            }).send();
        } catch (ex: any) {
            const error = ex?.message ?? ex.toString();
            if (findMyLiveTrackingFailureStatus(ex) === 404) throw new NotFound({ error });
            throw new ServerError({ message: "Failed to change Find My live tracking", error });
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
