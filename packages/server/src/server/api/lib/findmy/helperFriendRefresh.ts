export type FriendRefreshTrigger = "helper" | "relaunch";

/** The Private API helper, which runs inside Messages. */
export type FriendRefreshHelper = {
    connected: () => boolean;
    /** Sends "refresh-findmy-friends": the helper asks Find My to locate every friend */
    refreshFriends: () => Promise<unknown>;
};

/**
 * Starts Apple locating every friend. Prefers the Private API helper, which asks Find My's locate
 * service directly from inside Messages; relaunches the Find My app when the helper is not
 * connected or its request fails.
 */
export const triggerFriendRefresh = async (
    helper: FriendRefreshHelper,
    relaunchFindMy: () => Promise<void>,
    log: (message: string) => void
): Promise<FriendRefreshTrigger> => {
    if (helper.connected()) {
        try {
            await helper.refreshFriends();
            log("Find My friends refresh: asked the Private API helper to locate every friend");
            return "helper";
        } catch (error) {
            log(`Find My friends refresh: the Private API helper failed (${error}); relaunching Find My instead`);
        }
    } else {
        log("Find My friends refresh: the Private API helper is not connected; relaunching Find My");
    }
    await relaunchFindMy();
    return "relaunch";
};
