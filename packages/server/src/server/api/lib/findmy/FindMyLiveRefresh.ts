/** Fingerprint of a file, enough to tell that Find My has written it since the last look. */
export type FileFingerprint = { size: number; mtimeMs: number; ino: number };

/** Everything a live refresh touches, injected so it can be tested without Electron or Find My. */
export type LiveRefreshIo = {
    isFindMyRunning: () => Promise<boolean>;
    /** Whether Find My has finished starting; until then it refuses to quit (osascript -128) */
    isFindMyReady: () => Promise<boolean>;
    /** Asks Find My to quit; it is gone once isFindMyRunning says so */
    quitFindMy: () => Promise<void>;
    /** Launches Find My without showing it; it is up once isFindMyReady says so */
    launchFindMyHidden: () => Promise<void>;
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

/**
 * How long after a relaunch opening a Find My screen leaves Find My closed, unless the refresh
 * is forced. Chosen with the user, not Apple's: a quick look back shows the locations already sent.
 */
export const FIND_MY_RELAUNCH_COOLDOWN_MS = 2 * 60 * 1000;

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
 * Find My on this Mac mirrors the Find My screen on the clients. Find My only locates people when
 * it is launched, so opening a screen relaunches it hidden and each location it writes is
 * published as it lands; closing the last open screen quits it. A refresh requested while one is
 * collecting joins that one, and one within the cooldown of the last relaunch leaves Find My
 * closed unless it is forced.
 */
export class FindMyLiveRefresh {
    private active = false;
    private starting = false;
    private lastLaunchAt: number | null = null;
    private readonly viewers = new Set<string>();
    private cancelCheck: (() => void) | null = null;
    private readonly friends: Publisher;
    private readonly devices: Publisher;

    constructor(private readonly io: LiveRefreshIo) {
        const onError = (error: unknown) => io.log(`Find My refresh: failed to publish an update: ${error}`);
        this.friends = new Publisher(io.friendFiles, io.stat, io.publishFriends, onError);
        this.devices = new Publisher(io.deviceFiles, io.stat, io.publishDevices, onError);
    }

    get isActive(): boolean {
        return this.active;
    }

    /** A client's Find My screen opened or closed. Opening one starts a refresh; closing the last ends it. */
    setViewer(id: string, open: boolean): void {
        if (open) {
            this.viewers.add(id);
            void this.start();
            return;
        }
        if (this.viewers.delete(id)) this.endIfDone();
    }

    /**
     * Starts a refresh unless one is collecting or Find My was relaunched within the cooldown;
     * `force` relaunches it regardless, keeping a running refresh collecting. Resolves true once
     * Find My is up and its writes are being published, false if nothing was started or Find My
     * did not start. With no Find My screen open by then, nobody is looking, so it quits Find My.
     */
    async start({ force = false }: { force?: boolean } = {}): Promise<boolean> {
        if (this.starting || (this.active && !force)) return false;
        if (!force && this.lastLaunchAt !== null) {
            const since = this.io.now() - this.lastLaunchAt;
            if (since < FIND_MY_RELAUNCH_COOLDOWN_MS) {
                this.io.log(
                    `Find My refresh: relaunched Find My ${Math.round(since / 1000)} s ago; not relaunching until ` +
                        `${FIND_MY_RELAUNCH_COOLDOWN_MS / 1000} s have passed`
                );
                return false;
            }
        }
        this.active = true;
        this.starting = true;
        this.cancelCheck?.();
        this.cancelCheck = null;
        // Writes from here on are new to the client, which was just sent the current snapshot
        this.friends.baseline();
        this.devices.baseline();

        try {
            if ((await this.io.isFindMyRunning()) && !(await this.quit())) throw new Error("Find My did not quit");
            await this.io.launchFindMyHidden();
            if (!(await this.waitUntil(this.io.isFindMyReady, true))) throw new Error("Find My did not start");
        } catch (error) {
            this.io.log(`Find My refresh: ${error instanceof Error ? error.message : error}`);
            this.active = false;
            this.starting = false;
            return false;
        }

        this.starting = false;
        // Only a relaunch someone was looking at holds the next one back
        if (this.viewers.size > 0) this.lastLaunchAt = this.io.now();
        this.io.log("Find My refresh: relaunched Find My; publishing locations as it writes them");
        this.check();
        this.endIfDone();
        return true;
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
                    this.io.log(`Find My refresh: failed to quit Find My: ${error}`);
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
        if (!this.active) return;
        this.friends.check();
        this.devices.check();
        this.cancelCheck = this.io.schedule(() => this.check(), CHECK_MS);
    }

    /** Ends the refresh once no Find My screen is open; a refresh still starting ends once Find My is up. */
    private endIfDone(): void {
        if (!this.active || this.starting || this.viewers.size > 0) return;
        this.active = false;
        this.cancelCheck?.();
        this.cancelCheck = null;
        this.io.log("Find My refresh: no Find My screen is open; quitting Find My");
        void this.quit();
    }
}
