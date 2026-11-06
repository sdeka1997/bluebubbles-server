import assert from "node:assert/strict";
import test from "node:test";

import { FindMyMirror, FindMyMirrorIo, findMyScreenHandle } from "../src/server/api/lib/findmy/FindMyMirror";

type Fingerprint = { size: number; mtimeMs: number; ino: number };

const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

/** Apple's ids for the friends these tests name by handle. */
const roster = new Map([
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
        readyAfterMs?: number;
        refusesQuits?: number;
    } = {}
) => {
    const calls: string[] = [];
    const logs: string[] = [];
    const files = new Map<string, Fingerprint>([
        ["db", { size: 1, mtimeMs: 1, ino: 1 }],
        ["Devices.data", { size: 1, mtimeMs: 1, ino: 2 }]
    ]);
    let running = options.running ?? false;
    let ready = running;
    let now = 0;
    let timers: { at: number; fn: () => void; id: number }[] = [];
    let nextId = 0;
    let refusals = options.refusesQuits ?? 0;
    let neverStarts = options.neverStarts ?? false;
    let commandFailures = 0;
    let lookupFails = false;
    let releaseCommand: (() => void) | null = null;
    let blockCommands = false;
    let releasePublish: (() => void) | null = null;
    let blockPublish = false;

    const io: FindMyMirrorIo = {
        isFindMyRunning: async () => running,
        isFindMyReady: async () => running && ready,
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
            }, 200);
        },
        launchFindMyHidden: async () => {
            calls.push("launch");
            if (neverStarts) return;
            io.schedule(() => (running = true), 300);
            io.schedule(() => (ready = true), 300 + (options.readyAfterMs ?? 0));
        },
        launchedEarlier: () => options.launchedEarlier ?? false,
        forgetLaunch: () => calls.push("forget"),
        startLiveTracking: async friendId => {
            calls.push(`follow:${friendId}`);
            if (blockCommands) await new Promise<void>(resolve => (releaseCommand = resolve));
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
            if (lookupFails) throw new Error("The Find My FMF key is not imported");
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
        failLookups: () => (lookupFails = true),
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

test("a person who cannot be looked up is not followed", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    world.failLookups();

    await openMap(world, mirror, "pixel", "mom@example.com");
    await world.advance(2000);

    assert.deepEqual(world.follows(), []);
    assert.equal(world.isRunning(), true);
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
    world.refuseQuits(30);

    mirror.setViewer("pixel", true, "dad@example.com");
    await world.advance(10_000);
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
