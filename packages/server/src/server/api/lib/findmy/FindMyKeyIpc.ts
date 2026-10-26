import { FindMyKeyImportResult, FindMyKeyManager, FindMyKeysStatus } from "./FindMyKeyManager";

/**
 * The logic behind the `get-findmy-keys-status` and `import-findmy-keys` IPC handlers,
 * kept out of the IPC service so it can be tested without Electron.
 */

/** Resolves to the picked folder, or null if the user cancelled. */
export type FindMyKeysFolderPicker = () => Promise<string | null>;

export type FindMyKeysStatusResponse = {
    /** True on macOS 14.4+, where the Find My cache is encrypted and the keys are needed */
    supported: boolean;
    /** Null when unsupported, or before a key manager has been wired */
    status: FindMyKeysStatus | null;
};

export type FindMyKeysImportResponse = {
    canceled: boolean;
    result: FindMyKeyImportResult | { success: false; file: null; reason: "unavailable" | "error" } | null;
};

let manager: FindMyKeyManager | null = null;

/** Wires the key manager the IPC handlers use. Until this is called, both report unavailable. */
export const setFindMyKeyManager = (value: FindMyKeyManager | null): void => {
    manager = value;
};

export const getFindMyKeysStatus = async (supported: boolean): Promise<FindMyKeysStatusResponse> => {
    if (!supported || !manager) return { supported, status: null };
    return { supported, status: await manager.getStatus() };
};

export const importFindMyKeys = async (pickFolder: FindMyKeysFolderPicker): Promise<FindMyKeysImportResponse> => {
    if (!manager) return { canceled: false, result: { success: false, file: null, reason: "unavailable" } };

    const folder = await pickFolder();
    if (!folder) return { canceled: true, result: null };

    try {
        return { canceled: false, result: await manager.importFromDirectory(folder) };
    } catch {
        return { canceled: false, result: { success: false, file: null, reason: "error" } };
    }
};
