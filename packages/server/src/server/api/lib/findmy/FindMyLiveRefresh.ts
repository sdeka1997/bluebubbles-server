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
    /** Each friend's newest fix as last published (`at` in ms; 0 when they have no location) */
    friendLocations: () => { id: string; at: number }[];
    /** Tells clients a round started or ended (the findmy-round socket event) */
    announceRound: (round: FindMyRound) => void;
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
 * A round ends once no friend has reported for this long. Ours, not Apple's: Find My reports
 * people for ~5 minutes after a launch and then goes quiet, and the longest pause seen mid-round
 * was 34 s (2026-11-04, 5 rounds, 384 locations), so this is nearly twice that.
 */
export const FIND_MY_ROUND_QUIET_MS = 60 * 1000;

/** One round of locating: from a relaunch of Find My until every friend has reported or Apple goes quiet. */
export type FindMyRound = { collecting: boolean; startedAt: number | null };

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
 * it is launched, so opening a screen starts a round: Find My is relaunched hidden and each
 * location it writes is published as it lands. The round lasts until every friend has a location
 * newer than its start, or until none has reported for FIND_MY_ROUND_QUIET_MS; opening a screen
 * during it joins it. Find My runs while a round is on or a screen is open, and quits after both.
 */
export class FindMyLiveRefresh {
    private active = false;
    private starting = false;
    private current: FindMyRound = { collecting: false, startedAt: null };
    private located = 0;
    private lastNewAt = 0;
    private longestPauseMs = 0;
    private seenFixes = new Map<string, number>();
    private readonly viewers = new Set<string>();
    private cancelCheck: (() => void) | null = null;
    private readonly friends: Publisher;
    private readonly devices: Publisher;

    constructor(private readonly io: LiveRefreshIo) {
        const onError = (error: unknown) => io.log(`Find My refresh: failed to publish an update: ${error}`);
        this.friends = new Publisher(io.friendFiles, io.stat, io.publishFriends, onError);
        this.devices = new Publisher(io.deviceFiles, io.stat, io.publishDevices, onError);
    }

    /** Whether Find My is running and its writes are being published. */
    get isActive(): boolean {
        return this.active;
    }

    get round(): FindMyRound {
        return { ...this.current };
    }

    /** A client's Find My screen opened or closed. Opening one starts or joins a round. */
    setViewer(id: string, open: boolean): void {
        if (open) {
            this.viewers.add(id);
            void this.start();
            return;
        }
        if (this.viewers.delete(id)) this.endIfDone();
    }

    /**
     * Starts a round unless one is on, which this joins; `force` relaunches Find My and starts a
     * new round regardless. Resolves true once Find My is up and its writes are being published,
     * false if this joined a round or Find My did not start.
     */
    async start({ force = false }: { force?: boolean } = {}): Promise<boolean> {
        if (this.starting || (this.current.collecting && !force)) {
            if (this.current.startedAt !== null) {
                const ago = Math.round((this.io.now() - this.current.startedAt) / 1000);
                this.io.log(`Find My refresh: joining the round started ${ago} s ago`);
            }
            return false;
        }
        this.active = true;
        this.starting = true;
        this.cancelCheck?.();
        this.cancelCheck = null;
        this.beginRound();
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
            this.endRound();
            return false;
        }

        this.starting = false;
        this.io.log("Find My refresh: relaunched Find My; publishing locations as it writes them");
        this.check();
        return true;
    }

    private beginRound(): void {
        const now = this.io.now();
        this.current = { collecting: true, startedAt: now };
        this.located = 0;
        this.lastNewAt = now;
        this.longestPauseMs = 0;
        this.seenFixes = new Map(this.io.friendLocations().map(friend => [friend.id, friend.at]));
        this.io.announceRound(this.round);
    }

    private endRound(): void {
        if (!this.current.collecting) return;
        this.current = { ...this.current, collecting: false };
        this.io.announceRound(this.round);
    }

    /** Ends the round once every friend has reported since it began, or none has for the quiet time. */
    private trackRound(): void {
        if (!this.current.collecting || this.current.startedAt === null) return;
        const startedAt = this.current.startedAt;
        const friends = this.io.friendLocations();
        const located = friends.filter(friend => friend.at > startedAt).length;
        const hasNewFix = friends.some(
            friend => friend.at > startedAt && friend.at > (this.seenFixes.get(friend.id) ?? 0)
        );
        for (const friend of friends) {
            this.seenFixes.set(friend.id, Math.max(friend.at, this.seenFixes.get(friend.id) ?? 0));
        }
        const now = this.io.now();
        if (hasNewFix) {
            if (this.located > 0) this.longestPauseMs = Math.max(this.longestPauseMs, now - this.lastNewAt);
            this.lastNewAt = now;
        }
        this.located = located;
        const everyone = friends.length > 0 && located === friends.length;
        if (!everyone && now - this.lastNewAt < FIND_MY_ROUND_QUIET_MS) return;
        this.io.log(
            `Find My refresh: round over: ${located} of ${friends.length} located; ` +
                `longest pause ${Math.round(this.longestPauseMs / 1000)} s`
        );
        this.endRound();
        this.endIfDone();
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
        this.trackRound();
        if (this.active) this.cancelCheck = this.io.schedule(() => this.check(), CHECK_MS);
    }

    /** Quits Find My once the round is over and no Find My screen is open. */
    private endIfDone(): void {
        if (!this.active || this.starting || this.current.collecting || this.viewers.size > 0) return;
        this.active = false;
        this.cancelCheck?.();
        this.cancelCheck = null;
        this.io.log("Find My refresh: round over and no Find My screen is open; quitting Find My");
        void this.quit();
    }
}
