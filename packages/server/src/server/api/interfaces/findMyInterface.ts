import { Server } from "@server";
import path from "path";
import fs from "fs";
import child_process from "child_process";
import { randomBytes } from "crypto";
import { FileSystem } from "@server/fileSystem";
import { isMinBigSur, isMinSonoma, isMinSonoma14_4 } from "@server/env";
import { checkPrivateApiStatus, waitMs } from "@server/helpers/utils";
import {
    quitFindMyFriends,
    startFindMyFriends,
    showFindMyFriends,
    hideFindMyFriends,
    isFindMyFriendsRunning
} from "../apple/scripts";
import { FileFingerprint, FindMyMirror } from "@server/api/lib/findmy/FindMyMirror";
import { FindMyDevice, FindMyItem, FindMyLocationItem } from "@server/api/lib/findmy/types";
import { transformFindMyItemToDevice } from "@server/api/lib/findmy/utils";
import {
    assertFindMyLocationsFresh,
    assertFindMyLocationsUsable,
    loadBeaconStoreKey,
    readFindMyFriendsFromSecureCache,
    supportsSecureLocationCacheReader
} from "@server/api/lib/findmy/SecureLocationReader";
import { startBackgroundFindMyRefresh } from "@server/api/lib/findmy/BackgroundFindMyRefresh";
import { PrivateApiFindMyEventHandler } from "@server/api/privateApi/eventHandlers/PrivateApiFindMyEventHandler";
import { FindMyAddressLabeler, createAppleGeocodeBatch } from "@server/api/lib/findmy/AppleReverseGeocoder";
import {
    EncryptedDevicesBackend,
    EncryptedFriendsBackend,
    getEncryptedDevices,
    readEncryptedDevices,
    readEncryptedFriends,
    refreshEncryptedFriends,
    selectFindMyBackend
} from "@server/api/lib/findmy/FindMyEncryptedBackend";
import { FIND_MY_DEVICES_UPDATED } from "@server/events";
import { readFmfRosterData } from "@server/api/lib/findmy/decrypt/fmfReader";
import { readFriendLocations } from "@server/api/lib/findmy/decrypt/localStorageReader";
import {
    findMyLiveLaunchArguments,
    FindMyLiveBridgeHost,
    isFindMyLiveBridgeListening,
    requestFindMyLiveBridge
} from "@server/api/lib/findmy/FindMyLiveBridgeHost";
import { buildFindMyRoster, findMyFriendIdForHandle } from "@server/api/lib/findmy/FindMyFriendRoster";

export class FindMyInterface {
    // Shared so the coordinate-cell cache survives between refreshes. Created lazily because
    // `FileSystem.resources` depends on the app path, which is only known after Electron starts.
    private static labeler: FindMyAddressLabeler | null = null;

    private static getLabeler(): FindMyAddressLabeler | null {
        if (!this.labeler && fs.existsSync(FileSystem.findMyReverseGeocoder)) {
            this.labeler = new FindMyAddressLabeler(createAppleGeocodeBatch(FileSystem.findMyReverseGeocoder));
        }

        return this.labeler;
    }

    /**
     * Publishes locations with a "City, ST" address in place of Apple's missing label.
     * Locations the geocoder could not place keep their coordinates as the address.
     * Coordinates are geocoded only through Apple's on-device CLGeocoder via the packaged
     * helper. The cache drops a labelled copy whose coordinates have since been superseded.
     */
    private static async publishWithAddresses(locations: FindMyLocationItem[]): Promise<void> {
        const labeler = this.getLabeler();
        const labeled = labeler
            ? await labeler.labelWithin(locations, 3000)
            : { current: locations, late: null };
        const handler = new PrivateApiFindMyEventHandler();
        await handler.handleNewLocation(labeled.current);
        if (labeled.late) {
            void labeled.late.then(late => handler.handleNewLocation(late)).catch(() => undefined);
        }
    }

    static async getFriends() {
        return Server().findMyCache.getAll();
    }

    private static mirror: FindMyMirror | null = null;
    private static liveBridge: FindMyLiveBridgeHost | null = null;

    private static openFindMy(args: string[]): Promise<void> {
        return new Promise((resolve, reject) => {
            child_process.execFile("/usr/bin/open", args, error => (error ? reject(error) : resolve()));
        });
    }

    private static getLiveBridge(): FindMyLiveBridgeHost {
        if (this.liveBridge) return this.liveBridge;
        this.liveBridge = new FindMyLiveBridgeHost(
            {
                randomToken: () => randomBytes(32).toString("hex"),
                removeSocket: socketPath => {
                    try {
                        fs.unlinkSync(socketPath);
                    } catch (error: any) {
                        if (error?.code !== "ENOENT") throw error;
                    }
                },
                launchFindMy: environment => this.openFindMy(findMyLiveLaunchArguments(environment)),
                request: requestFindMyLiveBridge,
                isListening: isFindMyLiveBridgeListening
            },
            FileSystem.findMyLiveBridge,
            FileSystem.findMyLiveSocket
        );
        return this.liveBridge;
    }

    /**
     * The Find My mirror for macOS 14.4+: Find My runs while a client's map is open, publishing
     * friends and devices as it writes them, and quits when the last map closes.
     */
    private static getMirror(): FindMyMirror {
        if (this.mirror) return this.mirror;
        const stat = (file: string): FileFingerprint | null => {
            try {
                const { size, mtimeMs, ino } = fs.statSync(file);
                return { size, mtimeMs, ino };
            } catch (_) {
                return null;
            }
        };
        const friendsBackend = this.encryptedFriendsBackend();
        this.mirror = new FindMyMirror({
            isFindMyRunning: () => this.isFindMyRunning(),
            isFindMyReady: () => this.isFindMyReady(),
            // Bounded, so a Find My too busy to answer cannot hold up the check for AppleScript's ~2 min
            quitFindMy: () =>
                new Promise<void>((resolve, reject) => {
                    child_process.execFile(
                        "/usr/bin/osascript",
                        ["-e", 'tell application "FindMy" to quit'],
                        { timeout: 5000 },
                        error => (error ? reject(error) : resolve())
                    );
                }),
            // Only Find My itself, by its exact process name; it opens again on the next launch
            forceQuitFindMy: () =>
                new Promise<void>((resolve, reject) => {
                    child_process.execFile("/usr/bin/killall", ["-KILL", "FindMy"], error =>
                        error && (error as any).code !== 1 ? reject(error) : resolve()
                    );
                }),
            // Hidden (-g -j) with the live-location bridge loaded; it idles until a friend is tapped
            launchFindMyHidden: () => this.getLiveBridge().launch(),
            // Only a Find My launched with the bridge listens on its socket; a leftover socket file does not
            isOurFindMyRunning: () => this.getLiveBridge().isOurs(),
            findMyPid: () =>
                new Promise(resolve => {
                    child_process.execFile("/usr/bin/pgrep", ["-x", "FindMy"], (error, stdout) => {
                        const pids = error ? [] : String(stdout).trim().split(/\s+/).map(Number).filter(Boolean);
                        resolve(pids.length === 1 ? pids[0] : null);
                    });
                }),
            forgetLaunch: () => this.getLiveBridge().reset(),
            friendIdFor: handle => this.friendIdForHandle(handle),
            startLiveTracking: friendId => this.getLiveBridge().start(friendId),
            stopLiveTracking: () => this.getLiveBridge().stop(),
            friendFiles: () => {
                const db = FileSystem.findMyLocalStorageDbPath;
                return [db, `${db}-wal`];
            },
            deviceFiles: () => ["Devices.data", "Items.data"].map(name => path.join(FileSystem.findMyDir, name)),
            stat,
            publishFriends: async () => {
                const current = await readEncryptedFriends(friendsBackend);
                if (current.length > 0) await this.publishWithAddresses(current);
            },
            publishDevices: async () => {
                const key = await Server().findMyKeys.loadCacheKey("FMIP");
                if (!key) return;
                const devices = readEncryptedDevices(key, FileSystem.findMyDir);
                if (devices) await Server().emitMessage(FIND_MY_DEVICES_UPDATED, devices, "normal", false, true);
            },
            schedule: (fn, ms) => {
                const timer = setTimeout(fn, ms);
                return () => clearTimeout(timer);
            },
            now: () => Date.now(),
            log: message => Server().logger.info(message)
        });
        return this.mirror;
    }

    /** Follows one friend live by Apple's phone/email handle, as clicking them in Find My does; null stops. */
    /** Apple's id for the friend a client names by phone/email; null when Find My has no such friend. */
    private static async friendIdForHandle(handle: string): Promise<string | null> {
        const key = await Server().findMyKeys.loadCacheKey("FMF");
        if (!key) throw new Error("The Find My FMF key is not imported");
        const roster = buildFindMyRoster(readFmfRosterData(key, FileSystem.findMyFmfCacheDir));
        return roster ? findMyFriendIdForHandle(roster, handle) : null;
    }

    /**
     * A client's Find My map opened or closed, and who it has selected (a phone/email, or null).
     * Find My runs while one is open and follows the selected person live.
     */
    static setFindMyViewer(clientId: string, open: boolean, handle: string | null = null): void {
        if (!isMinSonoma14_4) return;
        this.getMirror().setViewer(clientId, open, handle);
    }

    /**
     * macOS 14.4+ keeps friends and devices in encrypted caches, read with the user-imported keys.
     * Never uses the Private API helper, which no longer reports Find My data there.
     */
    private static encryptedFriendsBackend(): EncryptedFriendsBackend {
        const log = (message: string) => Server().logger.info(message);
        return {
            loadLocalStorageKey: () => Server().findMyKeys.loadLocalStorageKey(),
            loadFmfKey: () => Server().findMyKeys.loadCacheKey("FMF"),
            readRosterData: key => readFmfRosterData(key, FileSystem.findMyFmfCacheDir),
            readLocations: key => readFriendLocations(key, FileSystem.findMyLocalStorageDbPath),
            cache: Server().findMyCache,
            label: async locations => {
                // Wait briefly for cities so the response carries them; slower ones follow over the socket
                const labeler = this.getLabeler();
                if (!labeler) return locations;
                const labeled = await labeler.labelWithin(locations, 3000);
                if (labeled.late) {
                    void labeled.late
                        .then(late => new PrivateApiFindMyEventHandler().handleNewLocation(late))
                        .catch(() => undefined);
                }
                return labeled.current;
            },
            publish: locations => this.publishWithAddresses(locations),
            log
        };
    }

    private static encryptedDevicesBackend(): EncryptedDevicesBackend {
        return {
            loadFmipKey: () => Server().findMyKeys.loadCacheKey("FMIP"),
            findMyDir: FileSystem.findMyDir,
            log: message => Server().logger.info(message)
        };
    }

    static async getDevices(): Promise<Array<FindMyDevice> | null> {
        return await selectFindMyBackend(isMinSonoma14_4, {
            encrypted: () => getEncryptedDevices(this.encryptedDevicesBackend()),
            legacy: () => this.readPlaintextDevices()
        });
    }

    private static async readPlaintextDevices(): Promise<Array<FindMyDevice> | null> {
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
        return await selectFindMyBackend(isMinSonoma14_4, {
            // Find My runs while a map is open; this reads what it has written so far
            encrypted: () => getEncryptedDevices(this.encryptedDevicesBackend()),
            legacy: async () => {
                // Can't use the Private API to refresh devices yet
                await this.refreshLocationsAccessibility();
                return await this.readPlaintextDevices();
            }
        });
    }

    static async refreshFriends(openFindMyApp = true): Promise<FindMyLocationItem[]> {
        return await selectFindMyBackend(isMinSonoma14_4, {
            // Find My runs while a map is open; this reads what it has written so far
            encrypted: () => refreshEncryptedFriends(this.encryptedFriendsBackend()),
            legacy: () => this.refreshFriendsBefore14_4(openFindMyApp)
        });
    }

    private static async refreshFriendsBefore14_4(openFindMyApp: boolean): Promise<FindMyLocationItem[]> {
        let refreshedFindMyApp = false;
        // Find My's roster is authoritative for identity, favorites, and removals.
        Server().findMyCache.refreshRoster(true);

        // Before Sonoma, searchpartyd keeps current friend locations in its encrypted
        // SecureLocationCache. Prefer that direct source over the opportunistic
        // Messages/FMFSessions event cache, which has no on-demand refresh. Sonoma 14.4+
        // uses a different encrypted storage path and must be handled separately.
        if (
            supportsSecureLocationCacheReader(isMinSonoma) &&
            fs.existsSync(FileSystem.findMySecureLocationsDir) &&
            fs.existsSync(FileSystem.findMyFriendCachePath)
        ) {
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
                // Quit afterwards only if Find My was not already open: the server
                // owner may be using it, and closing it under them is not ours to do.
                const wasRunning = await this.isFindMyRunning();
                startBackgroundFindMyRefresh(
                    () => this.refreshLocationsAccessibility(),
                    readDirectLocations,
                    async locations => {
                        assertFindMyLocationsFresh(locations);
                        await this.publishWithAddresses(locations);
                    },
                    error => {
                        Server().logger.debug("Failed to refresh Find My friends from SecureLocationCache.");
                        Server().logger.debug(String(error));
                    },
                    wasRunning
                        ? undefined
                        : async () => {
                              await FileSystem.executeAppleScript(quitFindMyFriends());
                          }
                );
                refreshedFindMyApp = true;
            }

            try {
                const directLocations = readDirectLocations();
                assertFindMyLocationsUsable(directLocations);
                // Wait briefly for cities so the response carries them. Anything slower
                // (e.g. a cold cache after restart) shows coordinates and follows over the socket.
                const labeler = this.getLabeler();
                const labeled = labeler
                    ? await labeler.labelWithin(directLocations, 3000)
                    : { current: directLocations, late: null };
                Server().findMyCache.addAll(labeled.current);
                if (labeled.late) {
                    void labeled.late
                        .then(late => new PrivateApiFindMyEventHandler().handleNewLocation(late))
                        .catch(() => undefined);
                }

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

    /**
     * Whether Find My has finished starting (NSRunningApplication.finishedLaunching). Until then
     * it refuses to quit. Unknown counts as ready: quitting is retried while it refuses anyway.
     */
    static async isFindMyReady(): Promise<boolean> {
        const script =
            'ObjC.import("AppKit"); const app = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.apple.findmy").firstObject; ' +
            'app.isNil() ? "stopped" : app.finishedLaunching ? "ready" : "starting"';
        return new Promise(resolve => {
            child_process.execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], (error, stdout) =>
                resolve(error ? true : String(stdout).trim() === "ready")
            );
        });
    }

    static async isFindMyRunning(): Promise<boolean> {
        try {
            const out = await FileSystem.executeAppleScript(isFindMyFriendsRunning());
            return String(out).trim().toLowerCase() === "true";
        } catch (_) {
            // Unknown is treated as "running" so we err on the side of not quitting.
            return true;
        }
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
