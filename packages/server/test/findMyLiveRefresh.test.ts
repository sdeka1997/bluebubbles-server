import assert from "node:assert/strict";
import test from "node:test";

import {
    FIND_MY_ROUND_QUIET_MS,
    FindMyLiveRefresh,
    FindMyRound,
    LiveRefreshIo
} from "../src/server/api/lib/findmy/FindMyLiveRefresh";

type Fingerprint = { size: number; mtimeMs: number; ino: number };

const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

/** Find My, its files and a clock, all fake. `advance` runs due timers in order. */
const fakeWorld = (
    options: {
        neverStarts?: boolean;
        readyAfterMs?: number;
        startsMidLaunch?: boolean;
        refusesQuits?: number;
        friends?: string[];
    } = {}
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
    // Each friend's newest fix, as the friends cache holds it (0: no location)
    const fixes = new Map<string, number>((options.friends ?? ["dad", "mom", "kid"]).map(id => [id, 0]));
    const rounds: FindMyRound[] = [];
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
        friendLocations: () => [...fixes].map(([id, at]) => ({ id, at })),
        announceRound: round => rounds.push(round),
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
        rounds,
        /** Find My wrote a new fix for `id`, taken now */
        report: (id: string) => {
            fixes.set(id, now);
            touch("db");
        },
        launches: () => calls.filter(call => call === "launch-hidden").length,
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

test("opening the screen starts a round and says when it started", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    await world.advance(5000);

    refresh.setViewer("pixel", true);
    assert.deepEqual(
        refresh.round,
        { id: 1, collecting: true, startedAt: 5000, endedBy: null },
        "known at once, before Find My is up"
    );
    assert.deepEqual(world.rounds, [{ id: 1, collecting: true, startedAt: 5000, endedBy: null }]);
    await world.advance(1000);
    assert.equal(world.launches(), 1);
});

test("reopening the screen during a round joins it rather than relaunching Find My", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(5000);
    world.report("dad");
    await world.advance(6000);
    refresh.setViewer("pixel", false);
    await world.advance(7000);

    refresh.setViewer("pixel", true);
    await world.advance(1000);
    assert.equal(world.launches(), 1);
    assert.deepEqual(
        refresh.round,
        { id: 1, collecting: true, startedAt: 0, endedBy: null },
        "the round's own start, not the reopen"
    );
    assert.match(world.logs.join("\n"), /joining the round started 18 s ago/);
});

test("leaving during a round keeps Find My running until Apple goes quiet, then quits it", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(5000);
    world.report("dad");
    await world.advance(6000);
    refresh.setViewer("pixel", false);

    await world.advance(50_000);
    assert.equal(world.isRunning(), true, "Apple may still be sending");
    world.report("mom");
    await world.advance(FIND_MY_ROUND_QUIET_MS - 2000);
    assert.equal(world.isRunning(), true, "a new location keeps the round going");

    await world.advance(5000);
    assert.equal(refresh.round.collecting, false);
    assert.equal(world.isRunning(), false);
    assert.equal(refresh.isActive, false);
    assert.equal(world.pendingTimers(), 0, "no checks keep running");
    assert.deepEqual(world.rounds.at(-1), { id: 1, collecting: false, startedAt: 0, endedBy: "quiet" });
});

test("a pause shorter than the quiet time does not end the round", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(10_000);
    world.report("dad");
    // 34 s: the longest pause seen mid-round on 2026-11-04
    await world.advance(34_000);
    world.report("mom");
    await world.advance(34_000);
    assert.equal(refresh.round.collecting, true);
});

test("another fresh fix from an already located friend resets the quiet time", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(10_000);
    world.report("dad");
    await world.advance(FIND_MY_ROUND_QUIET_MS - 10_000);

    world.report("dad");
    await world.advance(20_000);

    assert.equal(refresh.round.collecting, true, "Apple is still writing fresh locations");
});

test("a round ends once nothing new has arrived for the quiet time, and says so", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(10_000);
    world.report("dad");
    await world.advance(30_000);
    world.report("mom");

    await world.advance(FIND_MY_ROUND_QUIET_MS + 2000);
    assert.equal(refresh.round.collecting, false);
    assert.deepEqual(world.rounds.at(-1), { id: 1, collecting: false, startedAt: 0, endedBy: "quiet" });
    assert.match(world.logs.join("\n"), /round over: 2 of 3 located; longest pause 30 s/);
});

test("a round ends as soon as every friend has a location newer than its start", async () => {
    const world = fakeWorld({ friends: ["dad", "mom"] });
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(5000);
    world.report("dad");
    await world.advance(5000);
    world.report("mom");

    await world.advance(2000);
    assert.equal(refresh.round.collecting, false);
    assert.match(world.logs.join("\n"), /round over: 2 of 2 located/);
});

test("a fix older than the round does not count as new", async () => {
    const world = fakeWorld({ friends: ["dad"] });
    const refresh = new FindMyLiveRefresh(world.io);
    await world.advance(10_000);
    world.report("dad");
    await world.advance(50_000);

    refresh.setViewer("pixel", true);
    await world.advance(30_000);
    assert.equal(refresh.round.collecting, true, "dad's fix predates the round");
});

test("the screen staying open after the round ends keeps Find My running; closing it then quits at once", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(2 * FIND_MY_ROUND_QUIET_MS);
    assert.equal(refresh.round.collecting, false);
    assert.equal(world.isRunning(), true);

    world.touch("db");
    await world.advance(1000);
    assert.equal(world.calls.at(-1), "publish-friends", "writes are still published while someone looks");

    refresh.setViewer("pixel", false);
    await world.advance(1000);
    assert.equal(world.isRunning(), false);
    assert.equal(world.pendingTimers(), 0);
});

test("opening the screen after a round has ended starts a new round", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(1000);
    refresh.setViewer("pixel", false);
    await world.advance(2 * FIND_MY_ROUND_QUIET_MS);
    assert.equal(world.isRunning(), false);

    refresh.setViewer("pixel", true);
    await world.advance(1000);
    assert.equal(world.launches(), 2);
    assert.deepEqual(refresh.round, {
        id: 2,
        collecting: true,
        startedAt: 1000 + 2 * FIND_MY_ROUND_QUIET_MS,
        endedBy: null
    });
});

test("reporting an already-open viewer again does not start another round", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(2 * FIND_MY_ROUND_QUIET_MS);
    assert.equal(refresh.round.collecting, false);
    assert.equal(world.launches(), 1);

    refresh.setViewer("pixel", true);
    await world.advance(1000);

    assert.equal(world.launches(), 1);
    assert.equal(refresh.round.collecting, false);
});

test("reopening while Find My is stopping serializes the stop before the new start", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(2 * FIND_MY_ROUND_QUIET_MS);
    world.calls.length = 0;

    refresh.setViewer("pixel", false);
    refresh.setViewer("pixel", true);
    await world.advance(1000);

    assert.equal(world.calls.filter(call => call === "quit").length, 1, "one coordinator owns the stop");
    assert.equal(world.launches(), 1);
    assert.equal(world.isRunning(), true);
});

test("a forced refresh during a round relaunches Find My and starts a new round", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(20_000);
    world.calls.length = 0;

    void refresh.start({ force: true });
    assert.deepEqual(refresh.round, { id: 2, collecting: true, startedAt: 20_000, endedBy: null });
    await world.advance(1000);
    assert.deepEqual(world.calls, ["quit", "launch-hidden"]);
    assert.ok(refresh.isActive);
    assert.equal(world.pendingTimers(), 1, "one file check keeps running, not two");
});

test("a forced refresh while Find My is still starting joins that start", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(250);

    assert.equal(await refresh.start({ force: true }), false);
    await world.advance(1000);
    assert.equal(world.launches(), 1);
});

test("a refresh requested with no Find My screen open runs its round, then quits Find My", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);

    const relaunched = refresh.start();
    await world.advance(2000);
    assert.equal(await relaunched, true);
    assert.equal(world.isRunning(), true);

    await world.advance(FIND_MY_ROUND_QUIET_MS);
    assert.equal(world.isRunning(), false);
});

test("Find My keeps running until every open Find My screen has closed", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    refresh.setViewer("tablet", true);
    await world.advance(2 * FIND_MY_ROUND_QUIET_MS);

    refresh.setViewer("pixel", false);
    await world.advance(1000);
    assert.ok(refresh.isActive, "another screen is still open");

    refresh.setViewer("tablet", false);
    await world.advance(1000);
    assert.equal(refresh.isActive, false);
    assert.equal(world.launches(), 1);
});

test("an open Find My screen keeps it publishing for as long as it stays open", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);

    await world.advance(60 * 60 * 1000);
    assert.ok(refresh.isActive);
    world.touch("db");
    await world.advance(1000);
    assert.equal(world.calls.at(-1), "publish-friends");
});

test("a write during a publish is published again once that publish finishes", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(1000);
    world.calls.length = 0;

    world.blockPublishes();
    world.touch("db");
    await world.advance(1000);
    world.touch("db");
    await world.advance(3000);
    assert.deepEqual(world.calls, ["publish-friends"], "one publish at a time");

    world.releasePublish();
    await world.advance(1000);
    assert.deepEqual(world.calls, ["publish-friends", "publish-friends"]);
});

test("a Find My that never starts ends the round, so the next one can try again", async () => {
    const world = fakeWorld({ neverStarts: true });
    const refresh = new FindMyLiveRefresh(world.io);

    const relaunched = refresh.start();
    await world.advance(30_000);
    assert.equal(await relaunched, false);
    assert.equal(refresh.isActive, false);
    assert.equal(refresh.round.collecting, false);
    assert.match(world.logs.join("\n"), /did not start/);
    assert.equal(world.pendingTimers(), 0);
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

test("leaving right after opening quits Find My cleanly once the round ends", async () => {
    const world = fakeWorld({ readyAfterMs: 2000 });
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(600);
    refresh.setViewer("pixel", false);

    await world.advance(FIND_MY_ROUND_QUIET_MS + 5000);
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
    assert.equal(world.launches(), 1);
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
    await world.advance(2 * FIND_MY_ROUND_QUIET_MS);
    refresh.setViewer("pixel", false);

    await world.advance(3000);
    assert.equal(world.isRunning(), false);
    assert.doesNotMatch(world.logs.join("\n"), /failed to quit/);
});

test("a round that ends because everyone reported says so", async () => {
    const world = fakeWorld({ friends: ["dad", "mom"] });
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(5000);
    world.report("dad");
    world.report("mom");
    await world.advance(2000);

    assert.deepEqual(world.rounds.at(-1), { id: 1, collecting: false, startedAt: 0, endedBy: "everyone" });
});

test("a Find My that never starts ends its round as failed", async () => {
    const world = fakeWorld({ neverStarts: true });
    const refresh = new FindMyLiveRefresh(world.io);
    const relaunched = refresh.start();
    await world.advance(30_000);
    await relaunched;

    assert.deepEqual(world.rounds.at(-1), { id: 1, collecting: false, startedAt: 0, endedBy: "failed" });
});

test("a forced refresh ends the round it replaces before announcing the new one", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(20_000);

    void refresh.start({ force: true });
    await world.advance(1000);

    assert.deepEqual(world.rounds, [
        { id: 1, collecting: true, startedAt: 0, endedBy: null },
        { id: 1, collecting: false, startedAt: 0, endedBy: "superseded" },
        { id: 2, collecting: true, startedAt: 20_000, endedBy: null }
    ]);
});

test("each round's end is announced once", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    await world.advance(3 * FIND_MY_ROUND_QUIET_MS);

    assert.equal(world.rounds.filter(round => round.id === 1 && !round.collecting).length, 1);
});
