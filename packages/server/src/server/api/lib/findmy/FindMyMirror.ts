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
    /** Whether a Find My launched by an earlier run of the server may still be running */
    launchedEarlier: () => boolean;
    /** Our launch of Find My is gone; drop what belonged to it (the bridge's token and socket) */
    forgetLaunch: () => void;
    /** Apple's id for the friend a client names by phone/email, or null when Find My has no such friend */
    friendIdFor: (handle: string) => Promise<string | null>;
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

/** How often the mirror compares Find My with the open maps, and checks its files for a new write. */
const CHECK_MS = 1000;

/** How often to make sure Find My is still running while nothing else has changed. Each check is an osascript. */
const ALIVE_CHECK_MS = 5000;

/** How long a launched Find My may take to start before it is launched again. It takes ~1 s. */
const START_LIMIT_MS = 20 * 1000;

/** How long a Find My asked to quit is given to go before it is asked again. It takes ~0.2 s. */
const QUIT_WAIT_MS = 2000;

/** Longest phone number or email Apple accepts is well under this; anything longer is not a handle. */
const HANDLE_LIMIT = 320;

/** The person a client's findmy-screen message selects, or null for nobody or anything unusable. */
export const findMyScreenHandle = (params: unknown): string | null => {
    const handle = (params as { handle?: unknown } | null)?.handle;
    if (typeof handle !== "string" || handle.trim().length === 0 || handle.length > HANDLE_LIMIT) return null;
    return handle;
};

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
 * Find My on this Mac, mirrored to the clients' maps, as Find My itself behaves: while a map is
 * open Find My runs (launched hidden for that opening, so Apple fetches everyone afresh), every
 * location it writes is published as it lands, and the person selected on the map is followed
 * live, as clicking them does. Once no map is open Find My is quit, which also ends any follow.
 *
 * Clients only say what they show. One check, every second, makes Find My match it, so a step
 * that fails is simply tried again on the next check; there is no recovery path of its own.
 */
export class FindMyMirror {
    /** Open maps and who each has selected, the most recently changed last */
    private readonly viewers = new Map<string, string | null>();
    /** Bumped each time a map opens with none open before; each opening gets its own Find My */
    private opening = 0;

    /** Whether the running Find My is one this server launched, and so may quit */
    private ours: boolean;
    /** The opening the running Find My was launched for; null when it must be relaunched */
    private launchedFor: number | null = null;
    private startingSince: number | null = null;
    private quitAskedAt: number | null = null;
    /** Whether Find My is up for the open maps: started, with its files being watched */
    private up = false;
    private lastAliveCheck = 0;
    /** Who Apple is following in the running Find My, as last confirmed */
    private followed: string | null = null;
    /** The last selection looked up, so each one is looked up once per launch */
    private lookedUp: { handle: string; friendId: string | null } | null = null;

    private stepping = false;
    private changed = true;
    private cancelNext: (() => void) | null = null;
    private lastLog = "";
    private readonly friends: Publisher;
    private readonly devices: Publisher;

    constructor(private readonly io: FindMyMirrorIo) {
        const onError = (error: unknown) => io.log(`Find My: failed to publish an update: ${error}`);
        this.friends = new Publisher(io.friendFiles, io.stat, io.publishFriends, onError);
        this.devices = new Publisher(io.deviceFiles, io.stat, io.publishDevices, onError);
        // A Find My left by an earlier run is ours to quit, and never serves a map as it is
        this.ours = io.launchedEarlier();
        this.check();
    }

    /** Whether any client has a Find My map open. */
    get isOpen(): boolean {
        return this.viewers.size > 0;
    }

    /** A client's Find My map opened, closed, or selected someone else (a phone/email, or null for nobody). */
    setViewer(id: string, open: boolean, handle: string | null = null): void {
        const wasOpen = this.isOpen;
        this.viewers.delete(id);
        if (open) this.viewers.set(id, handle);
        if (!wasOpen && this.isOpen) this.opening++;
        this.check();
    }

    /** Runs a check now, or right after the one running. */
    private check(): void {
        this.changed = true;
        if (this.stepping) return;
        this.cancelNext?.();
        this.cancelNext = null;
        this.stepping = true;
        void (async () => {
            let again = true;
            try {
                this.changed = false;
                again = await this.step();
            } catch (error) {
                this.log(`Find My: check failed: ${error}`);
            }
            this.stepping = false;
            if (this.changed) return this.check();
            if (again) {
                this.cancelNext = this.io.schedule(() => {
                    this.cancelNext = null;
                    this.check();
                }, CHECK_MS);
            }
        })();
    }

    /** One step towards Find My matching the open maps. Resolves whether to check again. */
    private async step(): Promise<boolean> {
        const now = this.io.now();
        const steady = this.up && !this.changed && now - this.lastAliveCheck < ALIVE_CHECK_MS;
        const running = steady || (await this.io.isFindMyRunning());
        if (!steady) this.lastAliveCheck = now;

        if (!running) {
            this.up = false;
            this.quitAskedAt = null;
            // Still starting: once it is up it is quit or used, as the maps then need
            if (this.startingSince !== null && now - this.startingSince < START_LIMIT_MS) return true;
            if (this.ours) this.io.forgetLaunch();
            this.ours = false;
            this.startingSince = null;
            if (!this.isOpen) return false;
            await this.launch();
            return true;
        }

        if (!this.isOpen) {
            // A Find My opened by hand is the user's own
            this.up = false;
            if (this.ours) await this.quit("no map is open");
            return this.ours;
        }

        if (this.launchedFor !== this.opening) {
            // Opened by hand, left by an earlier run, launched for an earlier opening, or in an unknown state
            this.up = false;
            await this.quit("relaunching it for the map");
            return true;
        }

        if (!this.up) {
            if (!(await this.io.isFindMyReady())) {
                if (this.startingSince !== null && now - this.startingSince >= START_LIMIT_MS) {
                    this.log("Find My: did not finish starting; relaunching it");
                    this.launchedFor = null;
                }
                return true;
            }
            // Writes from here on are new to the clients, which read the current snapshot on opening
            this.friends.baseline();
            this.devices.baseline();
            this.startingSince = null;
            this.up = true;
            this.log("Find My: open for the map; publishing locations as it writes them");
        }

        this.friends.check();
        this.devices.check();
        await this.follow(await this.selectedFriendId());
        return true;
    }

    private async launch(): Promise<void> {
        this.lookedUp = null;
        this.followed = null;
        this.startingSince = this.io.now();
        this.launchedFor = this.opening;
        this.ours = true;
        try {
            await this.io.launchFindMyHidden();
        } catch (error) {
            this.log(`Find My: failed to launch: ${error}`);
        }
    }

    /** Asks Find My to quit; a later check sees it gone. It refuses while starting (osascript -128). */
    private async quit(reason: string): Promise<void> {
        const now = this.io.now();
        if (this.quitAskedAt !== null && now - this.quitAskedAt < QUIT_WAIT_MS) return;
        if (!(await this.io.isFindMyReady())) return;
        try {
            await this.io.quitFindMy();
            this.quitAskedAt = now;
            this.log(`Find My: quitting it, as ${reason}`);
        } catch (error) {
            this.log(`Find My: failed to quit, trying again: ${error}`);
        }
    }

    /** Apple's id for the person the most recently changed map has selected, or null. */
    private async selectedFriendId(): Promise<string | null> {
        const handle = [...this.viewers.values()].pop() ?? null;
        if (handle === null) return null;
        if (this.lookedUp?.handle !== handle) {
            let friendId: string | null = null;
            try {
                friendId = await this.io.friendIdFor(handle);
                if (friendId === null) this.log("Find My: the selected person is not in Find My's roster");
            } catch (error) {
                this.log(`Find My: could not look up the selected person: ${error}`);
            }
            this.lookedUp = { handle, friendId };
        }
        return this.lookedUp.friendId;
    }

    private async follow(friendId: string | null): Promise<void> {
        if (friendId === this.followed) return;
        try {
            if (friendId === null) await this.io.stopLiveTracking();
            else await this.io.startLiveTracking(friendId);
            this.followed = friendId;
        } catch (error) {
            // Apple may still be following someone; a fresh Find My follows nobody
            this.log(`Find My: live location command failed; relaunching it: ${error}`);
            this.launchedFor = null;
        }
    }

    /** Logs a message once, not on every check that repeats it. */
    private log(message: string): void {
        if (message === this.lastLog) return;
        this.lastLog = message;
        this.io.log(message);
    }
}
