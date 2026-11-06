import assert from "node:assert/strict";
import test from "node:test";

import { FindMyMirror, FindMyMirrorIo } from "../src/server/api/lib/findmy/FindMyMirror";

type Fingerprint = { size: number; mtimeMs: number; ino: number };

const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

/** Find My, its files and a clock, all fake. `advance` runs due timers in order. */
const fakeWorld = (
    options: { running?: boolean; neverStarts?: boolean; readyAfterMs?: number; refusesQuits?: number } = {}
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
    let commandFailures = 0;
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
            if (!ready || refusals-- > 0) throw new Error("User canceled. (-128)");
            io.schedule(() => {
                running = false;
                ready = false;
            }, 200);
        },
        launchFindMyHidden: async () => {
            calls.push("launch");
            if (options.neverStarts) return;
            io.schedule(() => (running = true), 300);
            io.schedule(() => (ready = true), 300 + (options.readyAfterMs ?? 0));
        },
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
        launches: () => calls.filter(call => call === "launch").length,
        follows: () => calls.filter(call => call.startsWith("follow:") || call === "unfollow"),
        failNextCommand: () => commandFailures++,
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

const openMap = async (world: ReturnType<typeof fakeWorld>, mirror: FindMyMirror, id = "pixel") => {
    mirror.setViewer(id, true);
    await world.advance(1000);
};

test("opening the map launches Find My hidden and publishes each write as it lands", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);

    await openMap(world, mirror);
    assert.equal(world.launches(), 1);
    assert.equal(mirror.isOpen, true);
    assert.deepEqual(world.calls.filter(call => call.startsWith("publish")), [], "nothing new yet");

    world.touch("db");
    await world.advance(1000);
    world.touch("Devices.data");
    await world.advance(1000);
    assert.deepEqual(world.calls.filter(call => call.startsWith("publish")), ["publish-friends", "publish-devices"]);
});

test("opening the map relaunches a Find My that was already running, so Apple fetches afresh", async () => {
    const world = fakeWorld({ running: true });
    const mirror = new FindMyMirror(world.io);

    await openMap(world, mirror);

    assert.deepEqual(world.calls.slice(0, 2), ["quit", "launch"]);
    assert.equal(world.isRunning(), true);
});

test("a second open map shares the running Find My", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror, "pixel");

    await openMap(world, mirror, "laptop");
    mirror.setViewer("pixel", true);
    await world.advance(1000);

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

test("nothing is published once the map has closed", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);
    mirror.setViewer("pixel", false);
    await world.advance(1000);

    world.touch("db");
    await world.advance(5000);

    assert.deepEqual(world.calls.filter(call => call.startsWith("publish")), []);
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
    await world.advance(2000);

    assert.deepEqual(world.calls.filter(call => call === "quit" || call === "launch"), ["launch", "quit", "launch"]);
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

test("a Find My that never quits is tried again later while no map is open", async () => {
    const world = fakeWorld({ refusesQuits: 1000 });
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);
    mirror.setViewer("pixel", false);
    await world.advance(30_000);
    const quitsAfterFirstTry = world.calls.filter(call => call === "quit").length;

    await world.advance(60_000);

    assert.ok(world.calls.filter(call => call === "quit").length > quitsAfterFirstTry);
});

test("a Find My that never starts is logged, and the next open tries again", async () => {
    const world = fakeWorld({ neverStarts: true });
    const mirror = new FindMyMirror(world.io);
    mirror.setViewer("pixel", true);
    await world.advance(30_000);
    assert.match(world.logs.join("\n"), /did not start/);

    mirror.setViewer("pixel", false);
    await world.advance(1000);
    await openMap(world, mirror);
    assert.equal(world.launches(), 2);
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

test("tapping a person with the map open follows them in the running Find My", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);

    assert.equal(await mirror.follow("friend-one"), true);
    assert.equal(await mirror.follow("friend-two"), true);

    assert.deepEqual(world.follows(), ["follow:friend-one", "follow:friend-two"]);
    assert.equal(world.launches(), 1, "following never relaunches");
});

test("a tap with no map open is refused and sends nothing", async () => {
    const world = fakeWorld({ running: true });
    const mirror = new FindMyMirror(world.io);

    assert.equal(await mirror.follow("friend-one"), false);
    assert.deepEqual(world.follows(), []);
});

test("a tap while Find My is starting is applied once it is up", async () => {
    const world = fakeWorld({ readyAfterMs: 500 });
    const mirror = new FindMyMirror(world.io);
    mirror.setViewer("pixel", true);
    await world.advance(100);

    const tapped = mirror.follow("friend-one");
    await world.advance(2000);

    assert.equal(await tapped, true);
    assert.deepEqual(world.follows(), ["follow:friend-one"]);
});

test("only the last of several quick taps reports being followed", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);
    world.blockCommands();

    const first = mirror.follow("friend-one");
    await world.advance(0);
    const second = mirror.follow("friend-two");
    const third = mirror.follow("friend-three");
    world.releaseCommand();
    await world.advance(0);

    assert.equal(await first, false);
    assert.equal(await second, false);
    assert.equal(await third, true);
    assert.deepEqual(world.follows(), ["follow:friend-one", "follow:friend-three"]);
});

test("stopping keeps Find My up for the open map", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);
    await mirror.follow("friend-one");

    assert.equal(await mirror.follow(null), false);
    assert.deepEqual(world.follows(), ["follow:friend-one", "unfollow"]);
    assert.equal(world.isRunning(), true);
});

test("a failed follow or stop relaunches Find My, which follows nobody", async () => {
    for (const target of ["friend-two", null]) {
        const world = fakeWorld();
        const mirror = new FindMyMirror(world.io);
        await openMap(world, mirror);
        await mirror.follow("friend-one");
        world.failNextCommand();

        const result = mirror.follow(target);
        await world.advance(2000);

        assert.equal(await result, false, `${target}`);
        assert.equal(world.launches(), 2, `${target}: a fresh Find My`);
        assert.equal(world.isRunning(), true, `${target}: still up for the open map`);
    }
});

test("closing the map while following quits Find My at once, which ends the follow", async () => {
    const world = fakeWorld();
    const mirror = new FindMyMirror(world.io);
    await openMap(world, mirror);
    await mirror.follow("friend-one");

    mirror.setViewer("pixel", false);
    await world.advance(1000);

    assert.equal(world.isRunning(), false);
    assert.equal(await mirror.follow("friend-one"), false, "nothing to follow in");
});
