/** Fingerprint of a file, enough to tell that Find My has written it since the last look. */
export type FileFingerprint = { size: number; mtimeMs: number; ino: number };

/** Everything a live refresh touches, injected so it can be tested without Electron or Find My. */
export type LiveRefreshIo = {
    isFindMyRunning: () => Promise<boolean>;
    /** Asks Find My to quit; it is gone once isFindMyRunning says so */
    quitFindMy: () => Promise<void>;
    /** Launches Find My without showing it; it is up once isFindMyRunning says so */
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

/**
 * How long a refresh keeps collecting after it starts, even with nobody watching. Measured on
 * 2026-11-04 after a 30-minute quiet spell: 43% of friends had reported a new location within a
 * minute and 82% within five, so a quick look still leaves most of them fresh for the next visit.
 */
export const FIND_MY_COLLECT_MS = 5 * 60 * 1000;

/** How often Find My's files are checked for a new write. Each check is a few stat() calls. */
const CHECK_MS = 1000;

/** How often to look again while waiting for Find My to quit or to start. Each step takes ~0.1 s. */
const STEP_CHECK_MS = 100;

/** Only for a Find My that never quits or never starts: the steps themselves take ~0.1 s. */
const STEP_LIMIT_MS = 20 * 1000;

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
 * One refresh of Find My, as Apple's app produces it: Find My only locates people when it is
 * launched, then keeps writing new locations for minutes. So a refresh relaunches it hidden,
 * publishes each write as it lands, and quits it once five minutes have passed and no Find My
 * screen is open on a client. A refresh requested while one is collecting joins that one.
 */
export class FindMyLiveRefresh {
    private active = false;
    private startedAt = 0;
    private readonly viewers = new Set<string>();
    private cancelCheck: (() => void) | null = null;
    private cancelEnd: (() => void) | null = null;
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

    /** A client's Find My screen opened or closed. Closing the last one may end the refresh. */
    setViewer(id: string, open: boolean): void {
        if (open) {
            this.viewers.add(id);
            return;
        }
        if (this.viewers.delete(id)) this.endIfDone();
    }

    /**
     * Starts a refresh unless one is collecting. Resolves true once Find My is running and its
     * writes are being published, false if a refresh was already running or Find My did not start.
     */
    async start(): Promise<boolean> {
        if (this.active) return false;
        this.active = true;
        this.startedAt = this.io.now();
        // Writes from here on are new to the client, which was just sent the current snapshot
        this.friends.baseline();
        this.devices.baseline();

        try {
            if (await this.io.isFindMyRunning()) {
                await this.io.quitFindMy();
                if (!(await this.waitUntilRunning(false))) throw new Error("Find My did not quit");
            }
            await this.io.launchFindMyHidden();
            if (!(await this.waitUntilRunning(true))) throw new Error("Find My did not start");
        } catch (error) {
            this.io.log(`Find My refresh: ${error instanceof Error ? error.message : error}`);
            this.active = false;
            return false;
        }

        this.io.log("Find My refresh: relaunched Find My; publishing locations as it writes them");
        this.check();
        this.cancelEnd = this.io.schedule(() => {
            this.cancelEnd = null;
            this.endIfDone();
        }, FIND_MY_COLLECT_MS);
        return true;
    }

    private waitUntilRunning(running: boolean): Promise<boolean> {
        const deadline = this.io.now() + STEP_LIMIT_MS;
        return new Promise(resolve => {
            const look = async () => {
                if ((await this.io.isFindMyRunning()) === running) return resolve(true);
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

    private endIfDone(): void {
        if (!this.active || this.cancelEnd || this.viewers.size > 0) return;
        if (this.io.now() - this.startedAt < FIND_MY_COLLECT_MS) return;
        this.active = false;
        this.cancelCheck?.();
        this.cancelCheck = null;
        this.io.log("Find My refresh: finished collecting; quitting Find My");
        void this.io.quitFindMy().catch(error => this.io.log(`Find My refresh: failed to quit Find My: ${error}`));
    }
}
