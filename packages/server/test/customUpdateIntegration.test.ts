import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (file: string) => readFileSync(file, "utf8");

test("the update service uses BubbleBeam releases and its verified installer", () => {
    const update = source("src/server/services/updateService/index.ts");
    const policy = source("src/server/services/updateService/customBuildPolicy.ts");
    assert.match(policy, /sdeka1997\/bluebubbles-server/);
    assert.match(update, /UPDATE_REPOSITORY/);
    assert.match(update, /selectServerUpdate\(/);
    assert.match(update, /writeVerifiedStream\(/);
    assert.match(update, /async installUpdate\(/);
    assert.match(update, /install-bubblebeam-update\.sh/);
    assert.doesNotMatch(update, /OFFICIAL_UPDATES_ENABLED|autoUpdater/);
});

test("every existing Install Update entrance uses the one verified installer", () => {
    const tray = source("src/trays/AppTray.ts");
    const router = source("src/server/api/http/api/v1/routers/serverRouter.ts");
    const ipc = source("src/server/services/ipcService/index.ts");
    assert.match(tray, /Server\(\)\.updater\.installUpdate\(\)/);
    assert.match(router, /Server\(\)\.updater\.installUpdate\(\)/);
    assert.match(ipc, /Server\(\)\.updater\.installUpdate\(\)/);
    assert.doesNotMatch(tray, /autoUpdater/);
    assert.doesNotMatch(router, /autoUpdater/);
});

test("the first updater-capable server identifies itself as BubbleBeam build 20", () => {
    const policy = source("src/server/services/updateService/customBuildPolicy.ts");
    assert.match(policy, /CUSTOM_BUILD_NUMBER = 20/);
    assert.doesNotMatch(policy, /OFFICIAL_UPDATES_ENABLED/);
});


test("refresh failures and empty release results clear all cached update state", () => {
    const update = source("src/server/services/updateService/index.ts");
    const clearMethod = update.slice(update.indexOf("clearAvailableUpdateState"), update.indexOf("async checkForUpdate"));
    assert.match(clearMethod, /this\.availableUpdate = null/);
    assert.match(clearMethod, /this\.hasUpdate = false/);
    assert.match(clearMethod, /this\.updateInfo = null/);
    const catchStart = update.indexOf("} catch (ex: any)");
    const catchBlock = update.slice(catchStart, update.indexOf("this.hasUpdate =", catchStart));
    assert.match(catchBlock, /this\.clearAvailableUpdateState\(\)/);
    const noRelease = update.slice(update.indexOf("if (this.availableUpdate)"));
    assert.match(noRelease, /else \{\s*this\.clearAvailableUpdateState\(\)/);
});
