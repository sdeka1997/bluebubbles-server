import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import path from "node:path";
import { pipeline } from "node:stream/promises";

export const resolveCurrentAppPath = (executablePath: string): string =>
    path.resolve(path.dirname(executablePath), "../..");


export type UpdaterChild = {
    once(event: "error", listener: (error: Error) => void): unknown;
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    removeListener(event: "error", listener: (error: Error) => void): unknown;
    removeListener(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    kill(signal?: NodeJS.Signals): boolean;
};

export type UpdaterReadyOptions = {
    markerExists?: (markerPath: string) => Promise<boolean>;
    pollIntervalMs?: number;
    timeoutMs?: number;
};

export const waitForUpdaterReady = (
    child: UpdaterChild,
    markerPath: string,
    options: UpdaterReadyOptions = {}
): Promise<void> => {
    const markerExists = options.markerExists ?? (async marker => {
        try { await access(marker); return true; } catch { return false; }
    });
    const pollIntervalMs = options.pollIntervalMs ?? 100;
    const timeoutMs = options.timeoutMs ?? 30_000;

    return new Promise((resolve, reject) => {
        let settled = false;
        let pollTimer: NodeJS.Timeout | undefined;
        const timeoutTimer = setTimeout(() => {
            child.kill("SIGTERM");
            finish(new Error(`Updater helper readiness timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        const onError = (error: Error) => finish(error);
        const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
            finish(new Error(`Updater helper exited before readiness (code ${code}, signal ${signal ?? "none"}).`));
        const cleanup = () => {
            clearTimeout(timeoutTimer);
            if (pollTimer) clearTimeout(pollTimer);
            child.removeListener("error", onError);
            child.removeListener("exit", onExit);
        };
        const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error); else resolve();
        };
        const check = async () => {
            if (settled) return;
            try {
                if (await markerExists(markerPath)) return finish();
            } catch (error) {
                return finish(error instanceof Error ? error : new Error(String(error)));
            }
            pollTimer = setTimeout(check, pollIntervalMs);
        };
        child.once("error", onError);
        child.once("exit", onExit);
        void check();
    });
};

export type ReleaseAsset = { name: string; browser_download_url: string };
export type GitHubRelease = {
    tag_name: string;
    name?: string;
    body?: string;
    published_at?: string;
    html_url?: string;
    draft?: boolean;
    prerelease?: boolean;
    assets?: ReleaseAsset[];
};

export type ServerUpdateRelease = {
    build: number;
    release: GitHubRelease;
    archive: ReleaseAsset;
    checksum: ReleaseAsset;
};

const releaseBuild = (tag: string): number | null => {
    const match = /^v1\.9\.9-bubblebeam\.(\d+)$/.exec(tag);
    if (!match) return null;
    const build = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(build) ? build : null;
};

export const selectServerUpdate = (
    releases: GitHubRelease[],
    currentBuild: number,
    arch: "x64" | "arm64"
): ServerUpdateRelease | null => {
    const candidates = releases.flatMap(release => {
        if (release.draft || release.prerelease) return [];
        const build = releaseBuild(release.tag_name);
        if (build === null || build <= currentBuild) return [];

        const archivePattern = new RegExp(`^BubbleBeam-Server-1\\.9\\.9-b${build}-macos-${arch}\\.zip$`);
        const archive = release.assets?.find(asset => archivePattern.test(asset.name));
        if (!archive) return [];
        const checksum = release.assets?.find(asset => asset.name === `${archive.name}.sha256`);
        return checksum ? [{ build, release, archive, checksum }] : [];
    });

    candidates.sort((left, right) => right.build - left.build);
    return candidates[0] ?? null;
};

export const parseChecksum = (text: string, archiveName: string): string | null => {
    const match = /^([a-fA-F0-9]{64})  ([^/\r\n]+)\r?\n?$/.exec(text);
    if (!match || match[2] !== archiveName) return null;
    return match[1].toLowerCase();
};

export const writeVerifiedStream = async (
    input: Readable,
    destination: string,
    expectedSha256: string,
    maxBytes = 1024 * 1024 * 1024
): Promise<void> => {
    const partial = `${destination}.part`;
    const hash = createHash("sha256");
    let bytes = 0;
    const hasher = new Transform({
        transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                callback(new Error(`Update download exceeds the limit of ${maxBytes} bytes.`));
                return;
            }
            hash.update(chunk);
            callback(null, chunk);
        }
    });

    await rm(partial, { force: true });
    try {
        await pipeline(input, hasher, createWriteStream(partial, { flags: "wx", mode: 0o600 }));
        const actual = hash.digest("hex");
        if (actual !== expectedSha256.toLowerCase()) {
            throw new Error(`Update checksum mismatch: expected ${expectedSha256}, got ${actual}`);
        }
        await rename(partial, destination);
    } catch (error) {
        await rm(partial, { force: true });
        throw error;
    }
};
