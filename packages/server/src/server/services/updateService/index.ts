import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import axios from "axios";
import { app, BrowserWindow, dialog, MessageBoxOptions, Notification } from "electron";

import { Server } from "@server";
import { SERVER_UPDATE, SERVER_UPDATE_DOWNLOADING } from "@server/events";
import { FileSystem } from "@server/fileSystem";
import { ScheduledService } from "@server/lib/ScheduledService";
import { Loggable } from "@server/lib/logging/Loggable";
import {
    parseChecksum,
    resolveCurrentAppPath,
    selectServerUpdate,
    ServerUpdateRelease,
    writeVerifiedStream,
    waitForUpdaterReady
} from "./CustomUpdateRelease";
import { CUSTOM_BUILD_NUMBER, UPDATE_REPOSITORY } from "./customBuildPolicy";

export class UpdateService extends Loggable {
    tag = "UpdateService";
    window: BrowserWindow;
    timer: ScheduledService;
    currentVersion = app.getVersion();
    isOpen = false;
    hasUpdate = false;
    updateInfo: any = null;

    private availableUpdate: ServerUpdateRelease | null = null;
    private installing = false;

    constructor(window: BrowserWindow) {
        super();
        this.window = window;
    }

    start() {
        if (this.timer) return;
        this.timer = new ScheduledService(async () => {
            if (!this.hasUpdate) await this.checkForUpdate();
        }, 1000 * 60 * 60 * 12);
    }

    stop() {
        if (this.timer) {
            this.timer.stop();
            this.timer = null;
        }
    }

    private clearAvailableUpdateState(): void {
        this.availableUpdate = null;
        this.hasUpdate = false;
        this.updateInfo = null;
    }

    async checkForUpdate({ showNoUpdateDialog = false, showUpdateDialog = true } = {}): Promise<boolean> {
        try {
            const response = await axios.get(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases`, {
                headers: { Accept: "application/vnd.github.v3+json" },
                timeout: 30_000
            });
            const arch = process.arch === "arm64" ? "arm64" : "x64";
            this.availableUpdate = selectServerUpdate(response.data, CUSTOM_BUILD_NUMBER, arch);
        } catch (ex: any) {
            this.clearAvailableUpdateState();
            this.log.error(`Failed to fetch BubbleBeam release information: ${ex?.message ?? String(ex)}`);
            return false;
        }

        this.hasUpdate = this.availableUpdate !== null;
        if (this.availableUpdate) {
            const { build, release } = this.availableUpdate;
            const displayVersion = `${app.getVersion()}-bubblebeam.${build}`;
            this.updateInfo = {
                tag_name: release.tag_name,
                html_url: release.html_url,
                updateInfo: {
                    version: displayVersion,
                    releaseDate: release.published_at,
                    releaseName: release.name,
                    releaseNotes: release.body
                }
            };
            Server().emitMessage(SERVER_UPDATE, displayVersion);
            Server().emitToUI("update-available", displayVersion);
            Server().emit("update-available", displayVersion);
            if (showUpdateDialog) {
                new Notification({
                    title: "BubbleBeam Server Update Available",
                    body: `${release.name ?? displayVersion} is ready to install.`
                }).show();
            }
        } else {
            this.clearAvailableUpdateState();
            if (showNoUpdateDialog) {
                const options: MessageBoxOptions = {
                    type: "info",
                    title: "BubbleBeam Server Update",
                    message: "You have the latest version installed.",
                    detail: `BubbleBeam Server build ${CUSTOM_BUILD_NUMBER} is current.`
                };
                await dialog.showMessageBox(this.window, options);
            }
        }
        return this.hasUpdate;
    }

    /** Downloads and verifies the selected release, then hands the swap to a detached helper. */
    async installUpdate(): Promise<void> {
        if (this.installing) throw new Error("An update is already being installed.");
        if (!this.availableUpdate && !(await this.checkForUpdate({ showUpdateDialog: false }))) {
            throw new Error("No BubbleBeam Server update is available.");
        }
        const update = this.availableUpdate!;
        this.installing = true;
        Server().emitMessage(SERVER_UPDATE_DOWNLOADING, null);

        try {
            const checksumResponse = await axios.get(update.checksum.browser_download_url, {
                responseType: "text",
                timeout: 30_000,
                maxContentLength: 4096
            });
            const expected = parseChecksum(String(checksumResponse.data), update.archive.name);
            if (!expected) throw new Error("The release checksum file is malformed.");

            const directory = path.join(app.getPath("temp"), `bubblebeam-server-update-${update.build}`);
            await rm(directory, { recursive: true, force: true });
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const archive = path.join(directory, update.archive.name);
            const download = await axios.get(update.archive.browser_download_url, {
                responseType: "stream",
                timeout: 120_000,
                maxContentLength: 1024 * 1024 * 1024,
                maxBodyLength: 1024 * 1024 * 1024
            });
            await writeVerifiedStream(download.data as Readable, archive, expected, 1024 * 1024 * 1024);

            const helper = path.join(FileSystem.resources, "macos", "install-bubblebeam-update.sh");
            const readyMarker = path.join(directory, "helper.ready");
            await rm(readyMarker, { force: true });
            const currentApp = resolveCurrentAppPath(process.execPath);
            const child = spawn("/bin/bash", [
                helper,
                archive,
                expected,
                currentApp,
                readyMarker,
                String(process.pid),
                update.release.tag_name
            ], { detached: true, stdio: "ignore" });
            await waitForUpdaterReady(child, readyMarker);
            child.unref();
            app.quit();
        } catch (error) {
            this.installing = false;
            throw error;
        }
    }
}
