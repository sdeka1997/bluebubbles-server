/** Fingerprint of a file, enough to tell that Find My has written it since the last look. */
export type FileFingerprint = { size: number; mtimeMs: number; ino: number };

/** Everything the mirror touches, injected so it can be tested without Electron or Find My. */
export type FindMyMirrorIo = {
    isFindMyRunning: () => Promise<boolean>;
    /** Whether Find My has finished starting; until then it refuses to quit (osascript -128) */
    isFindMyReady: () => Promise<boolean>;
    /** Asks Find My to quit; it is gone once isFindMyRunning says so */
    quitFindMy: () => Promise<void>;
    /** Launches Find My without showing it, with the local live-location bridge loaded */
    launchFindMyHidden: () => Promise<void>;
    /** Starts/stops Apple's live session for one friend inside the running Find My */
    startLiveTracking: (friendId: string) => Promise<void>;
    stopLiveTracking: () => Promise<void>;
    /** Find My's friend locations (LocalStorage.db and its WAL) */
    friendFiles: () => string[];
    /** Find My's device and item caches */
    deviceFiles: () => string[];
    stat: (file: string) => FileFingerprint | null;
    /** Re-reads friends and emits the ones whose location changed */
    publishFriends: () => Promise<void>;
    /** Re-reads devices and emits them */
    publishDevices: () => Promise<void>;
    /** Runs `fn` after `ms`; the returned function cancels it */
    schedule: (fn: () => void, ms: number) => () => void;
    now: () => number;
    log: (message: string) => void;
};

/** How often Find My's files are checked for a new write. Each check is a few stat() calls. */
const CHECK_MS = 1000;

/** How often to look again while waiting for Find My to quit or to start. Each step takes ~0.1 s. */
const STEP_CHECK_MS = 100;

/** Only for a Find My that never quits or never starts: the steps themselves take ~0.1 s. */
const STEP_LIMIT_MS = 20 * 1000;

/** How long to wait before asking a Find My that would not quit, with no map open, again. */
const QUIT_RETRY_MS = 60 * 1000;

const sameFile = (a: FileFingerprint | null, b: FileFingerprint | null): boolean =>
    a === b || (!!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino);

/** Publishes one kind of data at a time; a change seen mid-publish is published again after it. */
class Publisher {
    private files: (FileFingerprint | null)[] = [];
    private running = false;
    private changedWhileRunning = false;

    constructor(
        private readonly list: () => string[],
        private readonly stat: (file: string) => FileFingerprint | null,
        private readonly publish: () => Promise<void>,
        private readonly onError: (error: unknown) => void
    ) {}

    /** Records the files as they are now, so only later writes count. */
    baseline(): void {
        this.files = this.list().map(this.stat);
    }

    check(): void {
        const files = this.list().map(this.stat);
        const changed = files.length !== this.files.length || files.some((file, i) => !sameFile(file, this.files[i]));
        this.files = files;
        if (changed) this.run();
    }

    private run(): void {
        if (this.running) {
            this.changedWhileRunning = true;
            return;
        }
        this.running = true;
        void (async () => {
            do {
                this.changedWhileRunning = false;
                try {
                    await this.publish();
                } catch (error) {
                    this.onError(error);
                }
            } while (this.changedWhileRunning);
            this.running = false;
        })();
    }
}

/**
 * Find My on this Mac, mirrored to the clients' maps, as Find My itself behaves: opening a map
 * opens Find My (relaunched hidden, so Apple fetches everyone afresh) and every location it writes
 * is published as it lands; tapping a person follows them live, as clicking them does; closing
 * the last map quits Find My, which also ends any follow. There are no rounds: rows show each
 * person's last known location and its age, as Apple's app does.
 */
export class FindMyMirror {
    private readonly viewers = new Set<string>();
    /** Whether Find My was launched for the open maps and is up, so taps can reach it */
    private up = false;
    /** The latest tap. An earlier tap still queued when another arrives is dropped. */
    private latestTap: string | null = null;
    /** Every launch, quit and bridge command runs here, one at a time, in order */
    private queue: Promise<void> = Promise.resolve();
    private cancelCheck: (() => void) | null = null;
    private cancelQuitRetry: (() => void) | null = null;
    private readonly friends: Publisher;
    private readonly devices: Publisher;

    constructor(private readonly io: FindMyMirrorIo) {
        const onError = (error: unknown) => io.log(`Find My: failed to publish an update: ${error}`);
        this.friends = new Publisher(io.friendFiles, io.stat, io.publishFriends, onError);
        this.devices = new Publisher(io.deviceFiles, io.stat, io.publishDevices, onError);
    }

    /** Whether any client has a Find My map open. */
    get isOpen(): boolean {
        return this.viewers.size > 0;
    }

    /** A client's Find My map opened or closed. The first open launches Find My; the last close quits it. */
    setViewer(id: string, open: boolean): void {
        const wasOpen = this.isOpen;
        if (open) this.viewers.add(id);
        else this.viewers.delete(id);
        if (!wasOpen && this.isOpen) void this.enqueue(() => this.launch());
        if (wasOpen && !this.isOpen) void this.enqueue(() => this.close());
    }

    /**
     * Follows one friend live, as clicking them in Find My does; another friend switches, null
     * stops. Acts only on the Find My an open map is running and never launches one. Resolves
     * true only when this friend is being followed and no later tap has replaced them.
     */
    follow(friendId: string | null): Promise<boolean> {
        this.latestTap = friendId;
        return this.enqueue(async () => {
            if (friendId !== this.latestTap || !this.up) return false;
            try {
                if (friendId === null) await this.io.stopLiveTracking();
                else await this.io.startLiveTracking(friendId);
            } catch (error) {
                // Apple may still be following someone; a fresh Find My follows nobody
                this.io.log(`Find My: live location command failed, relaunching: ${error}`);
                if (this.latestTap === friendId) this.latestTap = null;
                await this.launch();
                return false;
            }
            return friendId !== null && friendId === this.latestTap;
        });
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation);
        this.queue = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }

    /** Relaunches Find My hidden for the open maps and publishes what it writes from then on. */
    private async launch(): Promise<void> {
        if (!this.isOpen) return;
        this.stopWatching();
        this.cancelQuitRetry?.();
        this.cancelQuitRetry = null;
        this.up = false;
        if ((await this.io.isFindMyRunning()) && !(await this.quit())) {
            this.io.log("Find My: did not quit, so it was not relaunched");
            return;
        }
        // Writes from here on are new to the clients, which were just sent the current snapshot
        this.friends.baseline();
        this.devices.baseline();
        await this.io.launchFindMyHidden();
        if (!(await this.waitUntil(this.io.isFindMyReady, true))) {
            this.io.log("Find My: did not start");
            return;
        }
        if (!this.isOpen) return this.close();
        this.up = true;
        this.io.log("Find My: open for the map; publishing locations as it writes them");
        this.check();
    }

    /** Quits Find My once no map is open; that also ends Apple's live follow. */
    private async close(): Promise<void> {
        if (this.isOpen) return;
        this.stopWatching();
        this.up = false;
        this.latestTap = null;
        if (!(await this.io.isFindMyRunning())) return;
        if (await this.quit()) {
            this.io.log("Find My: map closed; quit Find My");
            return;
        }
        // A Find My left running could still be following someone; keep trying while no map is open
        this.io.log("Find My: did not quit; trying again later");
        this.cancelQuitRetry = this.io.schedule(() => {
            this.cancelQuitRetry = null;
            void this.enqueue(() => this.close());
        }, QUIT_RETRY_MS);
    }

    /**
     * Quits Find My once it has finished starting, asking again while it refuses (it does while
     * starting: osascript -128 "User canceled"). Resolves true once it is gone.
     */
    private async quit(): Promise<boolean> {
        if (!(await this.waitUntil(this.io.isFindMyReady, true))) return false;
        const deadline = this.io.now() + STEP_LIMIT_MS;
        for (;;) {
            try {
                await this.io.quitFindMy();
                break;
            } catch (error) {
                if (this.io.now() >= deadline) {
                    this.io.log(`Find My: failed to quit: ${error}`);
                    return false;
                }
                await new Promise<void>(resolve => this.io.schedule(resolve, STEP_CHECK_MS));
            }
        }
        return this.waitUntil(this.io.isFindMyRunning, false);
    }

    private waitUntil(state: () => Promise<boolean>, wanted: boolean): Promise<boolean> {
        const deadline = this.io.now() + STEP_LIMIT_MS;
        return new Promise(resolve => {
            const look = async () => {
                if ((await state()) === wanted) return resolve(true);
                if (this.io.now() >= deadline) return resolve(false);
                this.io.schedule(() => void look(), STEP_CHECK_MS);
            };
            void look();
        });
    }

    private check(): void {
        this.cancelCheck = null;
        if (!this.up) return;
        this.friends.check();
        this.devices.check();
        this.cancelCheck = this.io.schedule(() => this.check(), CHECK_MS);
    }

    private stopWatching(): void {
        this.cancelCheck?.();
        this.cancelCheck = null;
    }
}
