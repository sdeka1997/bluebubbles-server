import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";

import {
    GitHubRelease,
    parseChecksum,
    resolveCurrentAppPath,
    selectServerUpdate,
    writeVerifiedStream,
    waitForUpdaterReady
} from "../src/server/services/updateService/CustomUpdateRelease";

const release = (build: number, options: Partial<GitHubRelease> = {}): GitHubRelease => ({
    tag_name: `v1.9.9-bubblebeam.${build}`,
    name: `BubbleBeam Server build ${build}`,
    html_url: `https://github.com/sdeka1997/bluebubbles-server/releases/tag/v1.9.9-bubblebeam.${build}`,
    assets: [
        {
            name: `BubbleBeam-Server-1.9.9-b${build}-macos-x64.zip`,
            browser_download_url: `https://example.test/${build}.zip`
        },
        {
            name: `BubbleBeam-Server-1.9.9-b${build}-macos-x64.zip.sha256`,
            browser_download_url: `https://example.test/${build}.sha256`
        }
    ],
    ...options
});

test("selects the highest complete release newer than this server", () => {
    const selected = selectServerUpdate([release(20), release(23), release(22)], 21, "x64");
    assert.equal(selected?.build, 23);
    assert.equal(selected?.archive.name, "BubbleBeam-Server-1.9.9-b23-macos-x64.zip");
    assert.equal(selected?.checksum.name, "BubbleBeam-Server-1.9.9-b23-macos-x64.zip.sha256");
});

test("does not offer the installed build or an older one", () => {
    assert.equal(selectServerUpdate([release(20), release(19)], 20, "x64"), null);
});

test("ignores drafts, prereleases and tags outside BubbleBeam's release line", () => {
    assert.equal(
        selectServerUpdate(
            [
                release(30, { draft: true }),
                release(29, { prerelease: true }),
                release(28, { tag_name: "v9.9.9" })
            ],
            20,
            "x64"
        ),
        null
    );
});

test("requires both the archive and its checksum", () => {
    const onlyArchive = release(21);
    onlyArchive.assets = onlyArchive.assets?.slice(0, 1);
    assert.equal(selectServerUpdate([onlyArchive], 20, "x64"), null);
});

test("chooses only the archive built for this Mac", () => {
    const arm = release(21);
    arm.assets = arm.assets?.map(asset => ({
        ...asset,
        name: asset.name.replace("macos-x64", "macos-arm64")
    }));
    assert.equal(selectServerUpdate([arm], 20, "x64"), null);
    assert.equal(selectServerUpdate([arm], 20, "arm64")?.build, 21);
});

test("parses a checksum tied to the exact archive name", () => {
    const digest = "a".repeat(64);
    assert.equal(parseChecksum(`${digest}  BubbleBeam-Server-1.9.9-b21-macos-x64.zip\n`,
        "BubbleBeam-Server-1.9.9-b21-macos-x64.zip"), digest);
});

test("rejects a malformed checksum or one for another file", () => {
    assert.equal(parseChecksum(`not-a-hash  BubbleBeam.zip`, "BubbleBeam.zip"), null);
    assert.equal(parseChecksum(`${"b".repeat(64)}  Other.zip`, "BubbleBeam.zip"), null);
    assert.equal(parseChecksum(`${"c".repeat(64)}  ../BubbleBeam.zip`, "BubbleBeam.zip"), null);
});


test("writes a download only when its SHA-256 matches", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bubblebeam-update-"));
    try {
        const destination = path.join(dir, "server.zip");
        const contents = Buffer.from("signed server archive");
        const digest = createHash("sha256").update(contents).digest("hex");
        await writeVerifiedStream(Readable.from(contents), destination, digest);
        assert.deepEqual(await readFile(destination), contents);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a bad download cannot replace an existing archive and leaves no partial file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bubblebeam-update-"));
    try {
        const destination = path.join(dir, "server.zip");
        await writeFile(destination, "known good");
        await assert.rejects(
            writeVerifiedStream(Readable.from("tampered"), destination, "0".repeat(64)),
            /checksum/i
        );
        assert.equal(await readFile(destination, "utf8"), "known good");
        await assert.rejects(readFile(`${destination}.part`), /ENOENT/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});


test("the installer rejects a bad archive before touching the current app", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bubblebeam-installer-"));
    try {
        const archive = path.join(dir, "server.zip");
        const current = path.join(dir, "BlueBubbles.app");
        await writeFile(archive, "not the signed archive");
        await writeFile(current, "current app marker");
        const script = path.resolve("appResources/macos/install-bubblebeam-update.sh");
        const result = spawnSync("/bin/bash", [script, "--verify-only", archive, "0".repeat(64), current], {
            encoding: "utf8"
        });
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}${result.stderr}`, /checksum/i);
        assert.equal(await readFile(current, "utf8"), "current app marker");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("the installer is syntax-valid and contains rollback and identity gates", async () => {
    const script = path.resolve("appResources/macos/install-bubblebeam-update.sh");
    assert.equal(spawnSync("/bin/bash", ["-n", script]).status, 0);
    const source = await readFile(script, "utf8");
    for (const gate of [
        "codesign --verify --deep --strict",
        "designated requirement does not match",
        "CFBundleIdentifier",
        "PRAGMA integrity_check",
        "rolling back",
        "open -a",
        "--verify-only"
    ]) assert.match(source, new RegExp(gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // The running app writes cloudflare.pid into its own signed resources, invalidating its resource
    // seal. Its designated requirement remains the identity anchor; only the untouched new app must
    // pass strict verification before it is installed.
    assert.doesNotMatch(source, /codesign --verify --deep --strict "\$CURRENT"/);
    assert.doesNotMatch(source, /codesign --verify --deep --strict "\$BACKUP_APP"/);
});

test("resolves the app bundle root from the packaged executable", () => {
    assert.equal(
        resolveCurrentAppPath("/Applications/BlueBubbles.app/Contents/MacOS/BlueBubbles"),
        "/Applications/BlueBubbles.app"
    );
});


class FakeUpdaterChild extends EventEmitter {
    killed = false;
    kill(): boolean { this.killed = true; return true; }
}

test("waits for the updater ready marker before resolving", async () => {
    const child = new FakeUpdaterChild();
    let checks = 0;
    await waitForUpdaterReady(child, "/tmp/ready", {
        markerExists: async () => ++checks >= 2,
        pollIntervalMs: 1,
        timeoutMs: 100
    });
    assert.equal(checks, 2);
    assert.equal(child.killed, false);
});

test("rejects when the updater helper errors or exits before readiness", async () => {
    const errored = new FakeUpdaterChild();
    const errorWait = waitForUpdaterReady(errored, "/tmp/ready", {
        markerExists: async () => false, pollIntervalMs: 5, timeoutMs: 100
    });
    errored.emit("error", new Error("spawn failed"));
    await assert.rejects(errorWait, /spawn failed/);

    const exited = new FakeUpdaterChild();
    const exitWait = waitForUpdaterReady(exited, "/tmp/ready", {
        markerExists: async () => false, pollIntervalMs: 5, timeoutMs: 100
    });
    exited.emit("exit", 7, null);
    await assert.rejects(exitWait, /exited before readiness.*7/i);
});

test("terminates an updater helper that times out before readiness", async () => {
    const child = new FakeUpdaterChild();
    await assert.rejects(waitForUpdaterReady(child, "/tmp/ready", {
        markerExists: async () => false, pollIntervalMs: 1, timeoutMs: 10
    }), /timed out/i);
    assert.equal(child.killed, true);
});


test("a failed lock acquisition does not remove the other updater lock", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "bubblebeam-lock-"));
    try {
        const lock = path.join(home, "Library/Caches/com.bluebubbles.server-update.lock");
        await mkdir(lock, { recursive: true });
        const archive = path.join(home, "bad.zip");
        const current = path.join(home, "BlueBubbles.app");
        await writeFile(archive, "bad");
        await writeFile(current, "current");
        const script = path.resolve("appResources/macos/install-bubblebeam-update.sh");
        const result = spawnSync("/bin/bash", [script, "--verify-only", archive, "0".repeat(64), current], {
            encoding: "utf8", env: { ...process.env, HOME: home }
        });
        assert.notEqual(result.status, 0);
        await access(lock);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});


test("rejects BubbleBeam tags for any server version except exactly v1.9.9", () => {
    assert.equal(selectServerUpdate([release(21, { tag_name: "v2.0.0-bubblebeam.21" })], 20, "x64"), null);
});

test("ties the archive server version and build exactly to the release tag", () => {
    const wrongVersion = release(21);
    wrongVersion.assets = wrongVersion.assets?.map(asset => ({ ...asset, name: asset.name.replace("1.9.9", "2.0.0") }));
    assert.equal(selectServerUpdate([wrongVersion], 20, "x64"), null);

    const wrongBuild = release(21);
    wrongBuild.assets = wrongBuild.assets?.map(asset => ({ ...asset, name: asset.name.replace("-b21-", "-b22-") }));
    assert.equal(selectServerUpdate([wrongBuild], 20, "x64"), null);
});


test("rollback restores and integrity-checks config before reopening the old app", async () => {
    const script = await readFile(path.resolve("appResources/macos/install-bubblebeam-update.sh"), "utf8");
    assert.match(script, /restore_configuration\(\)/);
    assert.match(script, /CONFIG-wal/);
    assert.match(script, /CONFIG-shm/);
    const rollback = script.slice(script.indexOf("new server did not stay running; rolling back"));
    const stop = rollback.indexOf("stop_new_server");
    const restore = rollback.indexOf("restore_configuration");
    const reopen = rollback.indexOf("open -a");
    assert.ok(stop >= 0 && restore > stop && reopen > restore);
    assert.match(rollback, /PRAGMA integrity_check/);
});


test("rollback waits for the failed new server and escalates before swapping apps", async () => {
    const script = await readFile(path.resolve("appResources/macos/install-bubblebeam-update.sh"), "utf8");
    assert.match(script, /stop_new_server\(\)/);
    const stopFunction = script.slice(script.indexOf("stop_new_server()"), script.indexOf("restore_configuration()"));
    assert.match(stopFunction, /pkill -TERM/);
    assert.match(stopFunction, /server_is_running/);
    assert.match(stopFunction, /pkill -KILL/);
    const rollback = script.slice(script.indexOf("new server did not stay running; rolling back"));
    assert.ok(rollback.indexOf("stop_new_server") < rollback.indexOf('rm -rf "$CURRENT"'));
});


test("the installer rejects traversal ZIP entries before extraction", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "bubblebeam-traversal-"));
    try {
        const apps = path.join(home, "apps");
        const current = path.join(apps, "BlueBubbles.app");
        await mkdir(current, { recursive: true });
        const archive = path.join(home, "malicious.zip");
        const made = spawnSync("python3", ["-c", [
            "import sys, zipfile",
            "with zipfile.ZipFile(sys.argv[1], 'w') as z:",
            " z.writestr('../escaped.txt', 'owned')"
        ].join("\n"), archive], { encoding: "utf8" });
        assert.equal(made.status, 0, made.stderr);
        const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
        const script = path.resolve("appResources/macos/install-bubblebeam-update.sh");
        const result = spawnSync("/bin/bash", [script, "--verify-only", archive, digest, current], {
            encoding: "utf8", env: { ...process.env, HOME: home }
        });
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}${result.stderr}`, /unsafe archive path/i);
        await assert.rejects(readFile(path.join(apps, "escaped.txt")), /ENOENT/);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});


test("the installer rejects ZIP symlinks whose targets escape the archive root", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "bubblebeam-symlink-"));
    try {
        const current = path.join(home, "apps", "BlueBubbles.app");
        await mkdir(current, { recursive: true });
        const archive = path.join(home, "malicious-symlink.zip");
        const made = spawnSync("python3", ["-c", [
            "import sys, zipfile, stat",
            "with zipfile.ZipFile(sys.argv[1], 'w') as z:",
            " i=zipfile.ZipInfo('BlueBubbles.app/Contents/link')",
            " i.create_system=3",
            " i.external_attr=(stat.S_IFLNK | 0o777) << 16",
            " z.writestr(i, '../../../escaped.txt')"
        ].join("\n"), archive], { encoding: "utf8" });
        assert.equal(made.status, 0, made.stderr);
        const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
        const script = path.resolve("appResources/macos/install-bubblebeam-update.sh");
        const result = spawnSync("/bin/bash", [script, "--verify-only", archive, digest, current], {
            encoding: "utf8", env: { ...process.env, HOME: home }
        });
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}${result.stderr}`, /unsafe archive symlink target/i);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});


test("the installer rejects duplicate ZIP entry names before extraction", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "bubblebeam-duplicate-"));
    try {
        const current = path.join(home, "apps", "BlueBubbles.app");
        await mkdir(current, { recursive: true });
        const archive = path.join(home, "duplicate.zip");
        const made = spawnSync("python3", ["-c", [
            "import sys, zipfile",
            "with zipfile.ZipFile(sys.argv[1], 'w') as z:",
            " z.writestr('BlueBubbles.app/Contents/duplicate', 'first')",
            " z.writestr('BlueBubbles.app/Contents/duplicate', '../../escape')"
        ].join("\n"), archive], { encoding: "utf8" });
        assert.equal(made.status, 0, made.stderr);
        const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
        const script = path.resolve("appResources/macos/install-bubblebeam-update.sh");
        const result = spawnSync("/bin/bash", [script, "--verify-only", archive, digest, current], {
            encoding: "utf8", env: { ...process.env, HOME: home }
        });
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}${result.stderr}`, /duplicate archive entry/i);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});


test("configuration backups are private and process matching is escaped and anchored", async () => {
    const script = await readFile(path.resolve("appResources/macos/install-bubblebeam-update.sh"), "utf8");
    assert.match(script, /umask 077/);
    assert.match(script, /chmod 700 "\$BACKUP_DIR"/);
    assert.match(script, /chmod 600 "\$CONFIG_BACKUP"/);
    assert.match(script, /escape_process_pattern\(\)/);
    assert.match(script, /printf '\^%s\( \.\*\)\?\$'/);
    assert.doesNotMatch(script, /pgrep -f "\$CURRENT\/Contents\/MacOS\/BlueBubbles"/);
    assert.doesNotMatch(script, /pkill -(?:TERM|KILL) -f "\$CURRENT\/Contents\/MacOS\/BlueBubbles"/);
});


test("streaming download aborts at the byte cap and removes its partial file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "bubblebeam-cap-"));
    try {
        const destination = path.join(dir, "server.zip");
        await assert.rejects(
            writeVerifiedStream(Readable.from(Buffer.from("123456")), destination, "0".repeat(64), 5),
            /exceeds.*5.*bytes/i
        );
        await assert.rejects(readFile(destination), /ENOENT/);
        await assert.rejects(readFile(`${destination}.part`), /ENOENT/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
