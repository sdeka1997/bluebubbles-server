import assert from "node:assert/strict";
import test from "node:test";

import {
    FindMyBridgeNotReady,
    FindMyLiveRejected,
    FindMyMirror,
    FindMyMirrorIo,
    findMyScreenHandle
} from "../src/server/api/lib/findmy/FindMyMirror";

type Fingerprint = { size: number; mtimeMs: number; ino: number };

const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

/** Apple's ids for the friends these tests name by handle. */
const knownFriends = (): Map<string, string> => new Map([
    ["mom@example.com", "friend-mom"],
    ["dad@example.com", "friend-dad"],
    ["carol@example.com", "friend-carol"]
]);

/** Find My, its files and a clock, all fake. `advance` runs due timers in order. */
const fakeWorld = (
    options: {
        running?: boolean;
        launchedEarlier?: boolean;
        neverStarts?: boolean;
        neverReady?: boolean;
        /** How long after Find My is up its bridge keeps answering "not ready" (the shim scans after 15 s) */
        bridgeReadyAfterMs?: number;
        readyAfterMs?: number;
        refusesQuits?: number;
    } = {}
) => {
    const calls: string[] = [];
    const logs: string[] = [];
    const roster = knownFriends();
    const files = new Map<string, Fingerprint>([
        ["db", { size: 1, mtimeMs: 1, ino: 1 }],
        ["Devices.data", { size: 1, mtimeMs: 1, ino: 2 }]
    ]);
    let running = options.running ?? false;
    let ready = running;
    let now = 0;
    let osascripts = 0;
    let timers: { at: number; fn: () => void; id: number }[] = [];
    let nextId = 0;
    let refusals = options.refusesQuits ?? 0;
    let neverStarts = options.neverStarts ?? false;
    let commandFailures = 0;
    let lookupFailures = 0;
    let startRejection: string | null = null;
    let neverReady = options.neverReady ?? false;
    let forceQuitsIgnored = false;
    /** Whether the running Find My is one launched with our bridge, as opposed to opened by hand */
    let withBridge = running && (options.launchedEarlier ?? false);
    let upAt: number | null = withBridge ? 0 : null;
    let releaseCommand: (() => void) | null = null;
    let blockCommands = false;
    let releasePublish: (() => void) | null = null;
    let blockPublish = false;

    const io: FindMyMirrorIo = {
        isFindMyRunning: async () => {
            osascripts++;
            return running;
        },
        isFindMyReady: async () => {
            osascripts++;
            return running && ready;
        },
        quitFindMy: async () => {
            calls.push("quit");
            // Find My refuses to quit while it is still starting (osascript -128 "User canceled")
            if (!ready) throw new Error("User canceled. (-128)");
            if (refusals > 0) {
                refusals--;
                throw new Error("User canceled. (-128)");
            }
            io.schedule(() => {
                running = false;
                ready = false;
                withBridge = false;
                upAt = null;
            }, 200);
        },
        launchFindMyHidden: async () => {
            calls.push("launch");
            if (neverStarts) return;
            io.schedule(() => {
                running = true;
                withBridge = true;
            }, 300);
            if (!neverReady) {
                io.schedule(() => {
                    ready = true;
                    upAt = now;
                }, 300 + (options.readyAfterMs ?? 0));
            }
        },
        forceQuitFindMy: async () => {
            calls.push("force-quit");
            if (forceQuitsIgnored) return;
            running = false;
            ready = false;
            withBridge = false;
            upAt = null;
        },
        isOurFindMyRunning: async () => running && withBridge,
        forgetLaunch: () => calls.push("forget"),
        startLiveTracking: async friendId => {
            if (running && !withBridge) {
                // The user's own Find My: nothing listens on our socket
                calls.push("bridge-not-ready");
                throw new FindMyBridgeNotReady();
            }
            if (upAt === null || now - upAt < (options.bridgeReadyAfterMs ?? 0)) {
                calls.push("bridge-not-ready");
                throw new FindMyBridgeNotReady();
            }
            calls.push(`follow:${friendId}`);
            if (blockCommands) await new Promise<void>(resolve => (releaseCommand = resolve));
            if (startRejection) throw new FindMyLiveRejected(startRejection);
            if (commandFailures > 0) {
                commandFailures--;
                throw new Error("bridge unavailable");
            }
        },
        stopLiveTracking: async () => {
            calls.push("unfollow");
            if (commandFailures > 0) {
                commandFailures--;
                throw new Error("bridge unavailable");
            }
        },
        friendIdFor: async handle => {
            calls.push(`lookup:${handle}`);
            if (lookupFailures > 0) {
                lookupFailures--;
                throw new Error("The Find My FMF key is not imported");
            }
            return roster.get(handle) ?? null;
        },
        friendFiles: () => ["db"],
        deviceFiles: () => ["Devices.data"],
        stat: file => files.get(file) ?? null,
        publishFriends: async () => {
            calls.push("publish-friends");
            if (blockPublish) await new Promise<void>(resolve => (releasePublish = resolve));
        },
        publishDevices: async () => {
            calls.push("publish-devices");
        },
        schedule: (fn, ms) => {
            const id = nextId++;
            timers.push({ at: now + ms, fn, id });
            return () => {
                timers = timers.filter(timer => timer.id !== id);
            };
        },
        now: () => now,
        log: message => logs.push(message)
    };

    const advance = async (ms: number) => {
        const target = now + ms;
        await settle();
        for (;;) {
            timers.sort((a, b) => a.at - b.at || a.id - b.id);
            const due = timers[0];
            if (!due || due.at > target) break;
            timers.shift();
            now = due.at;
            due.fn();
            await settle();
        }
        now = target;
        await settle();
    };

    const touch = (file: string) => {
        const current = files.get(file)!;
        files.set(file, { ...current, mtimeMs: current.mtimeMs + 1 });
    };

    return {
        io,
        calls,
        logs,
        advance,
        touch,
        isRunning: () => running,
        /** Find My opened by hand on the Mac */
        openByHand: () => {
            running = true;
            ready = true;
            withBridge = false;
        },
        /** The user quits our Find My and opens their own between two checks */
        swapForOwn: () => {
            withBridge = false;
            upAt = null;
        },
        /** Find My quit by hand on the Mac */
        quitByHand: () => {
            running = false;
            ready = false;
        },
        launches: () => calls.filter(call => call === "launch").length,
        quits: () => calls.filter(call => call === "quit").length,
        follows: () => calls.filter(call => call.startsWith("follow:") || call === "unfollow"),
        lookups: () => calls.filter(call => call.startsWith("lookup:")).length,
        published: () => calls.filter(call => call.startsWith("publish")),
        failNextCommand: () => commandFailures++,
        failLookups: (count = 1000) => (lookupFailures = count),
        rejectStarts: (reason: string | null) => (startRejection = reason),
        addToRoster: (handle: string, friendId: string) => roster.set(handle, friendId),
        removeFromRoster: (handle: string) => roster.delete(handle),
        forceQuits: () => calls.filter(call => call === "force-quit").length,
        ignoreForceQuits: () => (forceQuitsIgnored = true),
        osascripts: () => osascripts,
        refuseQuits: (count: number) => (refusals = count),
        startWorking: () => (neverStarts = false),
        blockCommands: () => (blockCommands = true),
        releaseCommand: () => {
            blockCommands = false;
            releaseCommand?.();
        },
        blockPublishes: () => (blockPublish = true),
        releasePublish: () => {
            blockPublish = false;
            releasePublish?.();
        }
    };
};

type World = ReturnType<typeof fakeWorld>;

const openMap = async (world: World, mirror: FindMyMirror, id = "pixel", handle: string | null = null) => {
    mirror.setViewer(id, true, handle);
    await world.advance(2000);
};

test("opening the map launches Find My hidden and publishes each write as it lands", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);

    await openMap(world, mirror);
    assert.equal(world.launches(), 1);
    assert.equal(mirror.isOpen, true);
    assert.deepEqual(world.published(), [], "nothing new yet");

    world.touch("db");
    await world.advance(1000);
    world.touch("Devices.data");
    await world.advance(1000);
    assert.deepEqual(world.published(), ["publish-friends", "publish-devices"]);
});

test("opening the map relaunches a Find My that was already running, so Apple fetches afresh", async () => {
    const world = fakeWorld({ running: true });
    const mirror = new FindMyMirror(world.io);

    await openMap(world, mirror);

    assert.deepEqual(
        world.calls.filter(call => call === "quit" || call === "launch"),
        ["quit", "launch"]
    );
    assert.equal(world.isRunning(), true);
});

test("a second open map shares the running Find My", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror, "pixel");

    await openMap(world, mirror, "laptop");
    mirror.setViewer("pixel", true);
    await world.advance(2000);

    assert.equal(world.launches(), 1);
});

test("closing the last map quits Find My at once", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror, "pixel");
    await openMap(world, mirror, "laptop");

    mirror.setViewer("pixel", false);
    await world.advance(1000);
    assert.equal(world.isRunning(), true, "the laptop still has it open");

    mirror.setViewer("laptop", false);
    await world.advance(1000);
    assert.equal(world.isRunning(), false);
    assert.equal(mirror.isOpen, false);
});

test("nothing is published once the map has closed, and checking stops", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);
    mirror.setViewer("pixel", false);
    await world.advance(2000);
    const calls = world.calls.length;

    world.touch("db");
    await world.advance(60_000);

    assert.deepEqual(world.published(), []);
    assert.equal(world.calls.length, calls, "nothing left to do once Find My is gone");
});

test("closing the map while Find My is still starting quits it once it is up", async () => {
    const world = fakeWorld({ readyAfterMs: 2000 });
    const mirror = new FindMyMirror(world.io);
    mirror.setViewer("pixel", true);
    await world.advance(500);

    mirror.setViewer("pixel", false);
    await world.advance(5000);

    assert.equal(world.isRunning(), false);
});

test("reopening while Find My is quitting waits for the quit, then launches again", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);

    mirror.setViewer("pixel", false);
    mirror.setViewer("pixel", true);
    await world.advance(3000);

    assert.deepEqual(
        world.calls.filter(call => call === "quit" || call === "launch"),
        ["launch", "quit", "launch"]
    );
    assert.equal(world.isRunning(), true);
});

test("a Find My that refuses to quit is asked again until it does", async () => {
    const world = fakeWorld({ refusesQuits: 3 });
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);

    mirror.setViewer("pixel", false);
    await world.advance(5000);

    assert.equal(world.isRunning(), false);
});

test("a Find My that never starts is launched again while the map is open", async () => {
    const world = fakeWorld({ neverStarts: true });
    const mirror = new FindMyMirror(world.io);
    mirror.setViewer("pixel", true);
    await world.advance(10_000);
    assert.equal(world.launches(), 1, "it is given time to start");

    await world.advance(30_000);
    world.startWorking();
    await world.advance(30_000);

    assert.ok(world.launches() >= 2);
    assert.equal(world.isRunning(), true);
});

test("a Find My quit by hand while the map is open is launched again", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);

    world.quitByHand();
    await world.advance(7000);

    assert.equal(world.launches(), 2);
    assert.equal(world.isRunning(), true);
});

test("a Find My opened by hand with no map open is left alone", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);
    mirror.setViewer("pixel", false);
    await world.advance(2000);

    world.openByHand();
    await world.advance(60_000);

    assert.equal(world.quits(), 1, "only the Find My launched for the map was quit");
    assert.equal(world.isRunning(), true);
});

test("a Find My launched before a server restart is quit when no map is open", async () => {
    const world = fakeWorld({ running: true, launchedEarlier: true });
    new FindMyMirror(world.io);

    await world.advance(2000);

    assert.equal(world.isRunning(), false);
});

test("a write during a publish is published again once that publish finishes", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);
    world.blockPublishes();

    world.touch("db");
    await world.advance(1000);
    world.touch("db");
    await world.advance(1000);
    world.releasePublish();
    await world.advance(1000);

    assert.equal(world.calls.filter(call => call === "publish-friends").length, 2);
});

test("the selected person is followed, another switches, none stops", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);

    mirror.setViewer("pixel", true, "mom@example.com");
    await world.advance(1000);
    mirror.setViewer("pixel", true, "dad@example.com");
    await world.advance(1000);
    mirror.setViewer("pixel", true, null);
    await world.advance(1000);

    assert.deepEqual(world.follows(), ["follow:friend-mom", "follow:friend-dad", "unfollow"]);
    assert.equal(world.launches(), 1, "following never relaunches");
    assert.equal(world.isRunning(), true, "Find My stays up for the open map");
});

test("a selection sent with the opening is followed once Find My is up", async () => {
    const world = fakeWorld({ readyAfterMs: 500 });
    const mirror = new FindMyMirror(world.io);

    mirror.setViewer("pixel", true, "mom@example.com");
    await world.advance(100);
    assert.deepEqual(world.follows(), [], "nothing to follow in yet");
    await world.advance(3000);

    assert.deepEqual(world.follows(), ["follow:friend-mom"]);
});

test("the same selection reported again sends nothing more", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror, "pixel", "mom@example.com");

    mirror.setViewer("pixel", true, "mom@example.com");
    await world.advance(5000);

    assert.deepEqual(world.follows(), ["follow:friend-mom"]);
});

test("the person is looked up once per selection, not on every check", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror, "pixel", "mom@example.com");

    await world.advance(30_000);

    assert.equal(world.lookups(), 1);
});

test("of several quick selections only the last is followed", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror, "pixel", "mom@example.com");
    world.blockCommands();

    mirror.setViewer("pixel", true, "dad@example.com");
    await world.advance(0);
    mirror.setViewer("pixel", true, "carol@example.com");
    mirror.setViewer("pixel", true, "mom@example.com");
    mirror.setViewer("pixel", true, "carol@example.com");
    world.releaseCommand();
    await world.advance(2000);

    assert.deepEqual(world.follows(), ["follow:friend-mom", "follow:friend-dad", "follow:friend-carol"]);
});

test("with two maps open, the most recently changed one's selection is followed", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror, "pixel", "mom@example.com");
    await openMap(world, mirror, "laptop", "dad@example.com");

    mirror.setViewer("laptop", false);
    await world.advance(2000);

    assert.deepEqual(world.follows(), ["follow:friend-mom", "follow:friend-dad", "follow:friend-mom"]);
});

test("a person not in Find My's roster is not followed, which stops a follow", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror, "pixel", "mom@example.com");

    mirror.setViewer("pixel", true, "stranger@example.com");
    await world.advance(2000);

    assert.deepEqual(world.follows(), ["follow:friend-mom", "unfollow"]);
});

test("a person who cannot be looked up is not followed, and is looked up again", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    world.failLookups(2);

    await openMap(world, mirror, "pixel", "mom@example.com");
    assert.deepEqual(world.follows(), []);
    assert.equal(world.isRunning(), true);

    await world.advance(30_000);
    assert.deepEqual(world.follows(), ["follow:friend-mom"]);
});

test("a person added to Find My after being selected is followed once they appear", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror, "pixel", "new@example.com");
    assert.deepEqual(world.follows(), []);

    world.addToRoster("new@example.com", "friend-new");
    await world.advance(30_000);

    assert.deepEqual(world.follows(), ["follow:friend-new"]);
});

test("a person not in the roster is looked up again only now and then", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror, "pixel", "stranger@example.com");

    await world.advance(60_000);

    assert.ok(world.lookups() <= 7, `looked up ${world.lookups()} times in a minute`);
});

test("a person Find My refuses to follow is not retried by relaunching", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);
    world.rejectStarts("friend not found");

    mirror.setViewer("pixel", true, "mom@example.com");
    await world.advance(120_000);

    assert.equal(world.launches(), 1, "Find My is fine; only this person cannot be followed");
    assert.ok(world.follows().length <= 7, `asked ${world.follows().length} times in two minutes`);
    world.touch("db");
    await world.advance(1000);
    assert.ok(world.published().includes("publish-friends"), "the map keeps updating");
});

test("after a refusal, selecting someone else follows them at once", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);
    world.rejectStarts("friend not found");
    mirror.setViewer("pixel", true, "mom@example.com");
    await world.advance(2000);

    world.rejectStarts(null);
    mirror.setViewer("pixel", true, "dad@example.com");
    await world.advance(1000);

    assert.equal(world.follows().at(-1), "follow:friend-dad");
});

test("a Find My that is running but never finishes starting is force quit and launched again", async () => {
    const world = fakeWorld({ neverReady: true });
    const mirror = new FindMyMirror(world.io);
    mirror.setViewer("pixel", true);

    await world.advance(60_000);

    assert.ok(world.forceQuits() >= 1);
    assert.ok(world.launches() >= 2);
    assert.ok(world.osascripts() <= 75, `${world.osascripts()} osascripts in a minute: about one a second`);
});

test("a Find My that never finishes starting is force quit once no map is open", async () => {
    const world = fakeWorld({ neverReady: true });
    const mirror = new FindMyMirror(world.io);
    mirror.setViewer("pixel", true);
    await world.advance(3000);

    mirror.setViewer("pixel", false);
    await world.advance(30_000);
    const calls = world.calls.length;
    await world.advance(60_000);

    assert.equal(world.isRunning(), false);
    assert.equal(world.calls.length, calls, "and then nothing is left to do");
});

test("a Find My that will not quit is force quit after a while", async () => {
    const world = fakeWorld({ refusesQuits: 1000 });
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror, "pixel", "mom@example.com");

    mirror.setViewer("pixel", false);
    await world.advance(30_000);

    assert.equal(world.isRunning(), false, "a follow cannot outlive the map");
    assert.equal(world.forceQuits(), 1);
});

test("a selection with no map open sends nothing and launches nothing", async () => {
    const world = fakeWorld({ running: true });
    const mirror = new FindMyMirror(world.io);

    mirror.setViewer("pixel", false, "mom@example.com");
    await world.advance(5000);

    assert.deepEqual(world.follows(), []);
    assert.equal(world.launches(), 0);
});

test("a failed command relaunches Find My, which then follows the selection again", async () => {
    for (const selection of ["dad@example.com", null]) {
        const world = fakeWorld();
        const mirror = new FindMyMirror(world.io);
        await openMap(world, mirror, "pixel", "mom@example.com");
        world.failNextCommand();

        mirror.setViewer("pixel", true, selection);
        await world.advance(5000);

        assert.equal(world.launches(), 2, `${selection}: a fresh Find My`);
        assert.equal(world.isRunning(), true, `${selection}: still up for the open map`);
        const expected = selection === null ? [] : ["follow:friend-dad"];
        assert.deepEqual(world.follows().slice(2), expected, `${selection}: a fresh Find My follows nobody until asked`);
    }
});

test("after a failed command, a Find My that will not quit is asked again until it does", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror, "pixel", "mom@example.com");
    world.failNextCommand();
    world.refuseQuits(3);

    mirror.setViewer("pixel", true, "dad@example.com");
    await world.advance(4000);
    assert.equal(world.launches(), 1, "not relaunched while the old one is still up");
    assert.deepEqual(world.follows(), ["follow:friend-mom", "follow:friend-dad"], "nothing sent to a Find My in an unknown state");

    await world.advance(30_000);
    assert.equal(world.launches(), 2);
    assert.deepEqual(world.follows().slice(2), ["follow:friend-dad"]);
    world.touch("db");
    await world.advance(1000);
    assert.ok(world.published().includes("publish-friends"), "its writes are published again");
});

test("closing the map while following quits Find My at once, which ends the follow", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror, "pixel", "mom@example.com");

    mirror.setViewer("pixel", false);
    await world.advance(1000);

    assert.equal(world.isRunning(), false);
    assert.deepEqual(world.follows(), ["follow:friend-mom"], "quitting ends it; no stop is needed");
});

test("closing the map while a follow is still being sent quits Find My once it is sent", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);
    world.blockCommands();
    mirror.setViewer("pixel", true, "mom@example.com");
    await world.advance(0);

    mirror.setViewer("pixel", false);
    world.releaseCommand();
    await world.advance(2000);

    assert.equal(world.isRunning(), false);
});

test("the screen message names a selected person only by a usable handle", () => {
    assert.equal(findMyScreenHandle({ open: true, handle: "mom@example.com" }), "mom@example.com");
    assert.equal(findMyScreenHandle({ open: true, handle: null }), null);
    assert.equal(findMyScreenHandle({ open: true }), null, "clients from before selections");
    assert.equal(findMyScreenHandle({ open: true, handle: "   " }), null);
    assert.equal(findMyScreenHandle({ open: true, handle: 7 }), null);
    assert.equal(findMyScreenHandle({ open: true, handle: "a".repeat(321) }), null);
    assert.equal(findMyScreenHandle(null), null);
});

test("an earlier wait on a Find My that would not quit does not count against the user's own", async () => {
    const world = fakeWorld();
    world.openByHand();
    const mirror = new FindMyMirror(world.io);
    world.refuseQuits(5);

    mirror.setViewer("pixel", true);
    await world.advance(500);
    mirror.setViewer("pixel", false);
    await world.advance(3_600_000);

    world.refuseQuits(0);
    mirror.setViewer("pixel", true);
    await world.advance(3000);

    assert.equal(world.forceQuits(), 0, "asked to quit first, and it did");
    assert.ok(world.quits() >= 2);
});

test("a Find My opened by hand that will not quit is never force quit", async () => {
    const world = fakeWorld();
    world.openByHand();
    const mirror = new FindMyMirror(world.io);
    world.refuseQuits(1_000_000);

    mirror.setViewer("pixel", true);
    await world.advance(120_000);

    assert.equal(world.forceQuits(), 0, "it may hold the user's unsaved work");
    assert.equal(world.launches(), 0);
    assert.ok(world.logs.some(line => /not quit/.test(line)));
});

test("a force quit that does not end Find My is not repeated every check", async () => {
    const world = fakeWorld({ neverReady: true });
    world.ignoreForceQuits();
    const mirror = new FindMyMirror(world.io);
    mirror.setViewer("pixel", true);

    await world.advance(120_000);

    assert.ok(world.forceQuits() <= 6, `${world.forceQuits()} force quits in two minutes`);
});

test("Find My's bridge still starting up does not hold up the map closing or new locations", async () => {
    const world = fakeWorld({ bridgeReadyAfterMs: 15_000 });
    const mirror = new FindMyMirror(world.io);
    mirror.setViewer("pixel", true, "mom@example.com");
    await world.advance(3000);

    world.touch("db");
    await world.advance(1000);
    assert.ok(world.published().includes("publish-friends"), "published as it landed");

    mirror.setViewer("pixel", false);
    await world.advance(2000);
    assert.equal(world.isRunning(), false, "quit at once");
    await world.advance(30_000);
    assert.ok(!world.follows().some(call => call.startsWith("follow:")), "and nobody was followed after the map closed");
});

test("the selection is followed once Find My's bridge is ready, without a relaunch", async () => {
    const world = fakeWorld({ bridgeReadyAfterMs: 15_000 });
    const mirror = new FindMyMirror(world.io);
    mirror.setViewer("pixel", true, "mom@example.com");

    await world.advance(20_000);

    assert.deepEqual(world.follows(), ["follow:friend-mom"]);
    assert.equal(world.launches(), 1);
});

test("a map closed and reopened before Find My is up gets Find My again within seconds", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    mirror.setViewer("pixel", true);
    await world.advance(300);
    mirror.setViewer("pixel", false);
    await world.advance(3700);

    mirror.setViewer("pixel", true);
    await world.advance(5000);

    assert.equal(world.launches(), 2);
    assert.equal(world.isRunning(), true);
});

test("a Find My opened by hand while the server was down is not taken for ours", async () => {
    const world = fakeWorld({ running: true, launchedEarlier: false });
    new FindMyMirror(world.io);

    await world.advance(120_000);

    assert.equal(world.quits(), 0);
    assert.equal(world.forceQuits(), 0);
    assert.equal(world.isRunning(), true);
});

test("a Find My the user opened while ours never appeared is never force quit", async () => {
    const world = fakeWorld({ neverStarts: true });
    const mirror = new FindMyMirror(world.io);
    mirror.setViewer("pixel", true);
    await world.advance(5000);

    world.openByHand();
    await world.advance(60_000);

    assert.equal(world.forceQuits(), 0);
});

test("a Find My whose bridge never becomes ready keeps the map updating, follows nobody, and is not relaunched", async () => {
    const world = fakeWorld({ bridgeReadyAfterMs: Number.POSITIVE_INFINITY });
    const mirror = new FindMyMirror(world.io);
    mirror.setViewer("pixel", true, "mom@example.com");
    await world.advance(40_000);
    const asked = world.calls.filter(call => call === "bridge-not-ready").length;

    world.touch("db");
    await world.advance(60_000);

    assert.equal(world.launches(), 1);
    assert.ok(world.published().includes("publish-friends"));
    assert.equal(world.calls.filter(call => call === "bridge-not-ready").length, asked, "stopped asking");
    assert.ok(asked <= 35, `asked ${asked} times`);
});

test("our Find My swapped for the user's own between checks is not asked to quit when the map closes", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    mirror.setViewer("pixel", true, "mom@example.com");
    await world.advance(3000);
    assert.deepEqual(world.follows(), ["follow:friend-mom"]);

    world.swapForOwn();
    mirror.setViewer("pixel", true, "dad@example.com");
    await world.advance(1000);
    mirror.setViewer("pixel", false);
    await world.advance(60_000);

    assert.equal(world.quits(), 0);
    assert.equal(world.forceQuits(), 0);
    assert.equal(world.isRunning(), true);
});
