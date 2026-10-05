import { Server } from "@server";
import path from "path";
import fs from "fs";
import { FileSystem } from "@server/fileSystem";
import { isMinBigSur, isMinSequoia, isMinSonoma } from "@server/env";
import { checkPrivateApiStatus, waitMs } from "@server/helpers/utils";
import { quitFindMyFriends, startFindMyFriends, showFindMyFriends, hideFindMyFriends } from "../apple/scripts";
import { FindMyDevice, FindMyItem, FindMyLocationItem } from "@server/api/lib/findmy/types";
import { transformFindMyItemToDevice } from "@server/api/lib/findmy/utils";
import {
    assertFindMyLocationsFresh,
    assertFindMyLocationsUsable,
    loadBeaconStoreKey,
    readFindMyFriendsFromSecureCache
} from "@server/api/lib/findmy/SecureLocationReader";
import { startBackgroundFindMyRefresh } from "@server/api/lib/findmy/BackgroundFindMyRefresh";
import { PrivateApiFindMyEventHandler } from "@server/api/privateApi/eventHandlers/PrivateApiFindMyEventHandler";
import { FindMyAddressResolver, createAppleReverseGeocodeRunner } from "@server/api/lib/findmy/AppleReverseGeocoder";

export class FindMyInterface {
    // Shared across requests so the in-memory coordinate-cell cache and failure backoff
    // survive between refreshes. Initialized lazily because `FileSystem.resources` depends
    // on the app path, which is only known after Electron starts.
    private static addressResolver: FindMyAddressResolver | null = null;

    private static getAddressResolver(): FindMyAddressResolver | null {
        if (this.addressResolver) return this.addressResolver;

        const binary = FileSystem.findMyReverseGeocoder;
        if (!fs.existsSync(binary)) {
            Server().logger.debug("Find My reverse geocoder helper not present; leaving labels as 'Location'.");
            return null;
        }

        this.addressResolver = new FindMyAddressResolver(createAppleReverseGeocodeRunner(binary));
        return this.addressResolver;
    }

    /**
     * Applies any already-resolved labels to the cache, then kicks off background
     * resolution for the records still missing one. Resolved labels enrich the cached
     * entry and are re-emitted over the existing Find My socket path, so the Android
     * client picks up "City, ST" without another refresh. Coordinates are geocoded only
     * through Apple's on-device CLGeocoder via the packaged helper.
     */
    private static enrichMissingAddresses(locations: FindMyLocationItem[]): FindMyLocationItem[] {
        const resolver = this.getAddressResolver();
        if (!resolver) return locations;

        // Serve labels we already resolved on an earlier refresh.
        const withCachedLabels = resolver.applyCachedLabels(locations);
        for (const item of withCachedLabels) {
            if (!item.handle) continue;
            Server().findMyCache.enrichAddresses(item.handle, item.long_address, item.short_address);
        }

        resolver.resolveMissingLabels(
            locations,
            async (item, labels) => {
                if (!item.handle) return;
                Server().logger.debug(`Resolved Find My address label: ${labels.long}`);
                const enriched = Server().findMyCache.enrichAddresses(item.handle, labels.long, labels.short);
                if (enriched) {
                    await new PrivateApiFindMyEventHandler().handleNewLocation([enriched]);
                }
            },
            error => {
                Server().logger.debug("Failed to reverse geocode a Find My location.");
                Server().logger.debug(String(error));
            }
        );

        return withCachedLabels;
    }

    static async getFriends() {
        return Server().findMyCache.getAll();
    }

    static async getDevices(): Promise<Array<FindMyDevice> | null> {
        if (isMinSequoia) {
            Server().logger.debug('Cannot fetch FindMy devices on macOS Sequoia or later.');
            return null;
        }

        try {
            const [devices, items] = await Promise.all([
                FindMyInterface.readDataFile("Devices"),
                FindMyInterface.readDataFile("Items")
            ]);

            // Return null if neither of the files exist
            if (devices == null && items == null) return null;

            // Get any items with a group identifier
            const itemsWithGroup = items.filter(item => item.groupIdentifier);
            if (itemsWithGroup.length > 0) {
                try {
                    const itemGroups = await FindMyInterface.readItemGroups();
                    if (itemGroups) {
                        // Create a map of group IDs to group names
                        const groupMap = itemGroups.reduce((acc, group) => {
                            acc[group.identifier] = group.name;
                            return acc;
                        }, {} as Record<string, string>);

                        // Iterate over the items and add the group name
                        for (const item of items) {
                            if (item.groupIdentifier && groupMap[item.groupIdentifier]) {
                                item.groupName = groupMap[item.groupIdentifier];
                            }
                        }
                    }
                } catch (ex: any) {
                    Server().logger.debug('An error occurred while reading FindMy ItemGroups cache file.');
                    Server().logger.debug(String(ex));
                }
            }

            // Transform the items to match the same shape as devices
            const transformedItems = (items ?? []).map(transformFindMyItemToDevice);

            return [...(devices ?? []), ...transformedItems];
        } catch (ex: any) {
            Server().logger.debug("An error occurred while reading FindMy Device cache files.");
            Server().logger.debug(String(ex));
            return null;
        }
    }

    static async refreshDevices(): Promise<Array<FindMyDevice> | null> {
        // Can't use the Private API to refresh devices yet
        await this.refreshLocationsAccessibility();
        return await this.getDevices();
    }

    static async refreshFriends(openFindMyApp = true): Promise<FindMyLocationItem[]> {
        let refreshedFindMyApp = false;

        // searchpartyd keeps current friend locations in its encrypted
        // SecureLocationCache on every macOS version that ships it, so there is no
        // version gate here. Prefer that direct source over the opportunistic
        // Messages/FMFSessions event cache, which has no on-demand refresh.
        if (fs.existsSync(FileSystem.findMySecureLocationsDir) && fs.existsSync(FileSystem.findMyFriendCachePath)) {
            const readDirectLocations = () =>
                readFindMyFriendsFromSecureCache(
                    FileSystem.findMySecureLocationsDir,
                    FileSystem.findMyFriendCachePath,
                    loadBeaconStoreKey(),
                    (name, error) => {
                        Server().logger.debug(`Failed to decrypt SecureLocationCache record ${name}.`);
                        Server().logger.debug(String(error));
                    }
                );

            // The AppleScript bounce takes about 25 seconds, while the Android friends
            // endpoint uses the normal API timeout. Return the best current snapshot
            // immediately, refresh in the background, then publish changed locations
            // over the socket path the client already listens to.
            if (openFindMyApp) {
                startBackgroundFindMyRefresh(
                    () => this.refreshLocationsAccessibility(),
                    readDirectLocations,
                    async locations => {
                        assertFindMyLocationsFresh(locations);
                        // Apply already-resolved labels (including a friend's last known
                        // label) BEFORE publishing, so a friend whose coordinates shifted
                        // keeps "City, ST" instead of flashing back to "Location" while the
                        // new cell is reverse-geocoded in the background.
                        const enriched = this.enrichMissingAddresses(locations);
                        await new PrivateApiFindMyEventHandler().handleNewLocation(enriched);
                    },
                    error => {
                        Server().logger.debug("Failed to refresh Find My friends from SecureLocationCache.");
                        Server().logger.debug(String(error));
                    }
                );
                refreshedFindMyApp = true;
            }

            try {
                const directLocations = readDirectLocations();
                assertFindMyLocationsUsable(directLocations);
                Server().findMyCache.addAll(directLocations);
                this.enrichMissingAddresses(directLocations);
                return Server().findMyCache.getAll();
            } catch (ex: any) {
                // Fall through to the Messages/FMFSessions path below. On Monterey that path
                // has no on-demand refresh and usually returns stale data, but returning
                // whatever it holds beats failing the request outright.
                Server().logger.debug("Failed to read Find My friends from SecureLocationCache.");
                Server().logger.debug(String(ex));
            }
        }

        const papiEnabled = Server().repo.getConfig("enable_private_api") as boolean;
        if (papiEnabled && isMinBigSur && !isMinSonoma) {
            checkPrivateApiStatus();
            const result = await Server().privateApi.findmy.refreshFriends();
            const refreshLocations = result?.data?.locations ?? [];

            // Save the data to the cache
            // The cache will handle properly updating the data.
            Server().findMyCache.addAll(refreshLocations);
        }

        // No matter what, open the Find My app.
        // Don't await because it should update in the background.
        // Location updates get emitted as an event as they come in.
        if (openFindMyApp && !refreshedFindMyApp) {
            this.refreshLocationsAccessibility();
        }

        return Server().findMyCache.getAll();
    }

    static async refreshLocationsAccessibility() {
        await FileSystem.executeAppleScript(quitFindMyFriends());
        await waitMs(3000);

        // Make sure the Find My app is open.
        // Give it 5 seconds to open
        await FileSystem.executeAppleScript(startFindMyFriends());
        await waitMs(5000);

        // Bring the Find My app to the foreground so it refreshes the devices
        // Give it 15 seconods to refresh
        await FileSystem.executeAppleScript(showFindMyFriends());
        await waitMs(15000);

        // Re-hide the Find My App
        await FileSystem.executeAppleScript(hideFindMyFriends());
    }

    static async readItemGroups(): Promise<Array<any>> {
        const itemGroupsPath = path.join(FileSystem.findMyDir, "ItemGroups.data");
        if (!fs.existsSync(itemGroupsPath)) return [];

        return new Promise((resolve, reject) => {
            fs.readFile(itemGroupsPath, { encoding: "utf-8" }, (err, data) => {
                // Couldn't read the file
                if (err) return resolve(null);

                try {
                    const parsedData = JSON.parse(data.toString());
                    if (Array.isArray(parsedData)) {
                        return resolve(parsedData);
                    } else {
                        reject(new Error("Failed to read FindMy ItemGroups cache file! It is not an array!"));
                    }
                } catch {
                    reject(new Error("Failed to read FindMy ItemGroups cache file! It is not in the correct format!"));
                }
            });
        });
    }

    private static readDataFile<T extends "Devices" | "Items">(
        type: T
    ): Promise<Array<T extends "Devices" ? FindMyDevice : FindMyItem> | null> {
        const devicesPath = path.join(FileSystem.findMyDir, `${type}.data`);
        return new Promise((resolve, reject) => {
            fs.readFile(devicesPath, { encoding: "utf-8" }, (err, data) => {
                // Couldn't read the file
                if (err) return resolve(null);

                try {
                    const parsedData = JSON.parse(data.toString());
                    if (Array.isArray(parsedData)) {
                        return resolve(parsedData);
                    } else {
                        reject(new Error(`Failed to read FindMy ${type} cache file! It is not an array!`));
                    }
                } catch {
                    reject(new Error(`Failed to read FindMy ${type} cache file! It is not in the correct format!`));
                }
            });
        });
    }
}
