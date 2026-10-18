// Test-only stand-in for the Electron runtime so server modules can load under plain Node.
import Module from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const userDataDir = mkdtempSync(join(tmpdir(), "bb-electron-userdata-"));

const app: any = {
    getPath: () => userDataDir,
    setPath: () => undefined,
    getVersion: () => "0.0.0-test",
    getName: () => "bluebubbles-server",
    isPackaged: false,
    on: () => app,
    once: () => app,
    quit: () => undefined
};

const electron = new Proxy(
    { app, nativeTheme: { on: () => undefined }, systemPreferences: {}, dialog: {} },
    { get: (target: any, key) => (key in target ? target[key] : class {}) }
);

const originalLoad = (Module as any)._load;
(Module as any)._load = function load(request: string, ...rest: any[]) {
    if (request === "electron") return electron;
    return originalLoad.call(this, request, ...rest);
};
