import assert from "node:assert/strict";
import test from "node:test";

import { FindMyLiveRefresh, LiveRefreshIo } from "../src/server/api/lib/findmy/FindMyLiveRefresh";

type Fingerprint = { size: number; mtimeMs: number; ino: number };

const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

/** Find My, its files and a clock, all fake. `advance` runs due timers in order. */
const fakeWorld = (
    options: { neverStarts?: boolean; readyAfterMs?: number; startsMidLaunch?: boolean; refusesQuits?: number } = {}
) => {
    const calls: string[] = [];
    const logs: string[] = [];
    const files = new Map<string, Fingerprint>([
        ["db", { size: 1, mtimeMs: 1, ino: 1 }],
        ["db-wal", { size: 1, mtimeMs: 1, ino: 2 }],
        ["Devices.data", { size: 1, mtimeMs: 1, ino: 3 }]
    ]);
    let running = true;
    let ready = true;
    let now = 0;
    let timers: { at: number; fn: () => void; id: number }[] = [];
    let nextId = 0;
    let refusals = options.refusesQuits ?? 0;
    let releasePublish: (() => void) | null = null;
    let blockPublish = false;

    const io: LiveRefreshIo = {
        isFindMyRunning: async () => running,
        isFindMyReady: async () => running && ready,
        quitFindMy: async () => {
            calls.push("quit");
            // Find My refuses to quit while it is still starting (osascript -128 "User canceled")
            if (!ready || refusals-- > 0) throw new Error("User canceled. (-128)");
            // Quitting takes a moment to register, as it does for the real app
            io.schedule(() => (running = false), 200);
        },
        launchFindMyHidden: async () => {
            calls.push("launch-hidden");
            if (options.neverStarts) return;
            ready = false;
            io.schedule(() => (running = true), 300);
            io.schedule(() => (ready = true), 300 + (options.readyAfterMs ?? 0));
        },
        friendFiles: () => ["db", "db-wal"],
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

    if (options.startsMidLaunch) {
        // Launched by someone else a moment ago and still starting
        ready = false;
        io.schedule(() => (ready = true), options.readyAfterMs ?? 0);
    }

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
        pendingTimers: () => timers.length,
        blockPublishes: () => (blockPublish = true),
        releasePublish: () => {
            blockPublish = false;
            releasePublish?.();
        }
    };
};

test("relaunches Find My hidden, waiting only until each step has happened", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);

    refresh.setViewer("pixel", true);
    await world.advance(150);
    assert.deepEqual(world.calls, ["quit"], "waits for Find My to finish quitting before launching it");

    await world.advance(100);
    assert.deepEqual(world.calls, ["quit", "launch-hidden"]);
    await world.advance(400);
    assert.match(world.logs.join("\n"), /relaunched Find My/);
    assert.equal(world.isRunning(), true);
    // Quit registered at 200 ms and launch at 300 ms after it: the whole relaunch is under a
    // second, where the old bounce slept 3 + 5 + 15 s regardless.
    assert.ok(refresh.isActive);
});

test("publishes friends as soon as Find My writes their file, and devices as soon as theirs change", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(1000);
    world.calls.length = 0;

    await world.advance(3000);
    assert.deepEqual(world.calls, [], "nothing changed, nothing is published");

    world.touch("db-wal");
    await world.advance(1000);
    assert.deepEqual(world.calls, ["publish-friends"]);

    world.touch("Devices.data");
    await world.advance(1000);
    assert.deepEqual(world.calls, ["publish-friends", "publish-devices"]);
});

test("a refresh requested while one is collecting does not relaunch Find My", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(1000);

    assert.equal(await refresh.start(), false);
    await world.advance(1000);
    assert.equal(world.calls.filter(call => call === "launch-hidden").length, 1);
});

test("opening the Find My screen relaunches Find My hidden", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);

    refresh.setViewer("pixel", true);
    await world.advance(1000);
    assert.deepEqual(world.calls, ["quit", "launch-hidden"]);
    assert.ok(refresh.isActive);
});

test("closing the last Find My screen quits Find My at once and stops checking", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(30_000);

    refresh.setViewer("pixel", false);
    await world.advance(1000);
    assert.equal(refresh.isActive, false);
    assert.equal(world.calls.filter(call => call === "quit").length, 2, "quits Find My when the screen closes");
    assert.equal(world.isRunning(), false);
    assert.equal(world.pendingTimers(), 0, "no checks keep running after the screen closes");
});

test("an open Find My screen keeps it collecting for as long as it stays open", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);

    await world.advance(60 * 60 * 1000);
    assert.ok(refresh.isActive);
    world.touch("db");
    await world.advance(1000);
    assert.equal(world.calls.at(-1), "publish-friends");
});

test("Find My keeps running until every open Find My screen has closed", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    refresh.setViewer("tablet", true);
    await world.advance(1000);

    refresh.setViewer("pixel", false);
    await world.advance(1000);
    assert.ok(refresh.isActive, "another screen is still open");

    refresh.setViewer("tablet", false);
    await world.advance(1000);
    assert.equal(refresh.isActive, false);
    assert.equal(world.calls.filter(call => call === "launch-hidden").length, 1);
});

test("a screen that closes while Find My is still starting quits it once it is up", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(250);
    refresh.setViewer("pixel", false);

    await world.advance(2000);
    assert.equal(refresh.isActive, false);
    assert.equal(world.isRunning(), false);
    assert.equal(world.pendingTimers(), 0);
});

test("a refresh requested with no Find My screen open quits Find My once it has started", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);

    const relaunched = refresh.start();
    await world.advance(2000);
    assert.equal(await relaunched, true);
    assert.equal(refresh.isActive, false, "nobody is looking, so nothing is collected");
    assert.equal(world.isRunning(), false);
});

test("reopening the screen two minutes after the last relaunch relaunches Find My again", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(1000);
    refresh.setViewer("pixel", false);
    await world.advance(2 * 60 * 1000);

    refresh.setViewer("pixel", true);
    await world.advance(1000);
    assert.ok(refresh.isActive);
    assert.equal(world.calls.filter(call => call === "launch-hidden").length, 2);
});

test("reopening the screen within two minutes of the last relaunch leaves Find My closed", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(1000);
    refresh.setViewer("pixel", false);
    await world.advance(60 * 1000);
    world.calls.length = 0;

    refresh.setViewer("pixel", true);
    assert.equal(refresh.isActive, false, "a caller can tell at once that nothing is being collected");
    await world.advance(5000);
    assert.deepEqual(world.calls, [], "Find My is neither relaunched nor quit");
    assert.equal(world.isRunning(), false);
    assert.match(world.logs.join("\n"), /relaunched .* ago; not relaunching/);
});

test("the cooldown counts from the last relaunch, not from when the screen closed", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(110 * 1000);
    refresh.setViewer("pixel", false);
    await world.advance(15 * 1000);

    refresh.setViewer("pixel", true);
    await world.advance(1000);
    assert.equal(world.calls.filter(call => call === "launch-hidden").length, 2);
});

test("a forced refresh relaunches Find My during the cooldown", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(1000);
    refresh.setViewer("pixel", false);
    await world.advance(30 * 1000);
    refresh.setViewer("pixel", true);
    await world.advance(1000);
    assert.equal(refresh.isActive, false);

    void refresh.start({ force: true });
    assert.ok(refresh.isActive);
    await world.advance(1000);
    assert.equal(world.calls.filter(call => call === "launch-hidden").length, 2);
    assert.ok(refresh.isActive, "the screen is open, so it keeps collecting");
});

test("a forced refresh while collecting relaunches Find My and keeps collecting", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(6 * 60 * 1000);
    world.calls.length = 0;

    void refresh.start({ force: true });
    await world.advance(1000);
    assert.deepEqual(world.calls, ["quit", "launch-hidden"]);
    assert.ok(refresh.isActive);
    assert.equal(world.pendingTimers(), 1, "one file check keeps running, not two");
    world.touch("db");
    await world.advance(1000);
    assert.equal(world.calls.at(-1), "publish-friends");
});

test("a forced refresh while Find My is still starting joins that start", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(250);

    assert.equal(await refresh.start({ force: true }), false);
    await world.advance(1000);
    assert.equal(world.calls.filter(call => call === "launch-hidden").length, 1);
});

test("Find My counts as up only once it has finished starting, not when its process appears", async () => {
    const world = fakeWorld({ readyAfterMs: 2000 });
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(1000);
    assert.doesNotMatch(world.logs.join("\n"), /relaunched Find My/, "the process is there but still starting");

    await world.advance(2000);
    assert.match(world.logs.join("\n"), /relaunched Find My/);
});

test("leaving while Find My is still starting quits it once it has finished starting", async () => {
    const world = fakeWorld({ readyAfterMs: 2000 });
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(600);
    refresh.setViewer("pixel", false);

    await world.advance(4000);
    assert.doesNotMatch(world.logs.join("\n"), /failed to quit/);
    assert.equal(world.isRunning(), false);
    assert.equal(refresh.isActive, false);
});

test("coming back while Find My is still starting keeps it running", async () => {
    const world = fakeWorld({ readyAfterMs: 2000 });
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(600);
    refresh.setViewer("pixel", false);
    await world.advance(500);
    refresh.setViewer("pixel", true);

    await world.advance(4000);
    assert.ok(refresh.isActive);
    assert.equal(world.isRunning(), true);
    assert.equal(world.calls.filter(call => call === "launch-hidden").length, 1);
});

test("a Find My that is still starting when a refresh begins is quit only once it is up", async () => {
    const world = fakeWorld({ startsMidLaunch: true, readyAfterMs: 2000 });
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(1000);
    assert.deepEqual(world.calls, [], "waits for Find My to finish starting before asking it to quit");

    await world.advance(5000);
    assert.doesNotMatch(world.logs.join("\n"), /failed|did not/);
    assert.deepEqual(world.calls, ["quit", "launch-hidden"]);
    assert.ok(refresh.isActive);
});

test("a quit Find My refuses is asked again until it quits", async () => {
    const world = fakeWorld({ refusesQuits: 2 });
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(2000);
    refresh.setViewer("pixel", false);

    await world.advance(3000);
    assert.equal(world.isRunning(), false);
    assert.doesNotMatch(world.logs.join("\n"), /failed to quit/);
});

test("a relaunch nobody was looking at does not start the cooldown", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    const relaunched = refresh.start();
    await world.advance(2000);
    assert.equal(await relaunched, true);

    refresh.setViewer("pixel", true);
    await world.advance(2000);
    assert.ok(refresh.isActive, "the first look is not held back by a relaunch it never saw");
});
