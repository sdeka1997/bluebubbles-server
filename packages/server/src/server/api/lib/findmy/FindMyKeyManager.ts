import fs from "fs";
import path from "path";

export type FindMyKeyType = "LocalStorage" | "FMIP" | "FMF";

/** Canonical file names for each key, as produced by findmy-key-extractor. */
export const FIND_MY_KEY_FILES: Record<FindMyKeyType, string> = {
    LocalStorage: "LocalStorage.key",
    FMIP: "FMIPDataManager.bplist",
    FMF: "FMFDataManager.bplist"
};

const LOCAL_STORAGE_KEY_LENGTH = 32;
const MAX_PLIST_KEY_BYTES = 64 * 1024;

export type FindMyKeyValidator = (type: FindMyKeyType, data: Buffer) => void | Promise<void>;

export type FindMyCacheKeyExtractor = (type: "FMIP" | "FMF", data: Buffer) => Buffer | null | Promise<Buffer | null>;

export type FindMyKeyManagerOptions = {
    /** Where the imported keys live (FileSystem.findMyKeysDir in production) */
    keysDir: string;
    /** Deep check for a candidate key (e.g. does it decrypt real data); throw to reject it */
    validate: FindMyKeyValidator;
    /** Pulls the 32-byte symmetric key out of an FMIP/FMF DataManager bplist */
    extractCacheKey?: FindMyCacheKeyExtractor;
    /** Overridable for tests, to inject a fault mid-swap */
    rename?: (from: string, to: string) => void;
};

export type FindMyKeyState = "missing" | "invalid" | "ready";

export type FindMyKeysStatus = {
    /** Overall state: missing if any key is missing, else invalid if any key is invalid, else ready */
    state: FindMyKeyState;
    keys: Record<FindMyKeyType, FindMyKeyState>;
};

export type FindMyKeyImportFailureReason = "missing" | "invalid" | "commit-failed";

export type FindMyKeyImportResult =
    | { success: true }
    | { success: false; file: string; reason: FindMyKeyImportFailureReason };

const KEY_TYPES = Object.keys(FIND_MY_KEY_FILES) as FindMyKeyType[];

const isStructurallyValid = (type: FindMyKeyType, data: Buffer): boolean => {
    if (type === "LocalStorage") return data.length === LOCAL_STORAGE_KEY_LENGTH;
    if (data.length === 0 || data.length > MAX_PLIST_KEY_BYTES) return false;

    // Binary or XML plist
    const head = data.toString("utf8", 0, 6);
    return head === "bplist" || head === "<?xml " || head === "<plist";
};

export class FindMyKeyManager {
    private readonly keysDir: string;

    private cache: Partial<Record<FindMyKeyType, Buffer>> = {};

    private readonly validate: FindMyKeyValidator;

    private readonly extractCacheKey: FindMyCacheKeyExtractor;

    private readonly rename: (from: string, to: string) => void;

    constructor(options: FindMyKeyManagerOptions) {
        this.keysDir = options.keysDir;
        this.validate = options.validate;
        this.extractCacheKey = options.extractCacheKey ?? (() => null);
        this.rename = options.rename ?? fs.renameSync;
    }

    /** Clears the in-memory key cache. */
    clearCache(): void {
        this.cache = {};
    }

    private keyPath(type: FindMyKeyType): string {
        return path.join(this.keysDir, FIND_MY_KEY_FILES[type]);
    }

    /**
     * Loads and returns the 32-byte LocalStorage key (raw bytes), or null if unavailable.
     */
    loadLocalStorageKey(): Buffer | null {
        if (this.cache.LocalStorage) return this.cache.LocalStorage;

        const keyPath = this.keyPath("LocalStorage");
        if (!fs.existsSync(keyPath)) return null;

        const key = fs.readFileSync(keyPath);
        if (key.length !== LOCAL_STORAGE_KEY_LENGTH) return null;

        this.cache.LocalStorage = key;
        return key;
    }

    /**
     * Loads and returns a 32-byte ChaCha20 cache key (FMIP or FMF), or null if unavailable.
     */
    async loadCacheKey(type: "FMIP" | "FMF"): Promise<Buffer | null> {
        if (this.cache[type]) return this.cache[type];

        const keyPath = this.keyPath(type);
        if (!fs.existsSync(keyPath)) return null;

        try {
            const key = await this.extractCacheKey(type, fs.readFileSync(keyPath));
            if (!key) return null;

            this.cache[type] = key;
            return key;
        } catch {
            return null;
        }
    }

    /** Structural check plus the injected deep check. Never throws. */
    private async isValidKey(type: FindMyKeyType, data: Buffer): Promise<boolean> {
        if (!isStructurallyValid(type, data)) return false;

        try {
            await this.validate(type, data);
            return true;
        } catch {
            // The hook's message may describe key material, so it is never surfaced
            return false;
        }
    }

    /**
     * Validates a candidate key file before importing it.
     */
    async validateKeyFile(type: FindMyKeyType, filePath: string): Promise<boolean> {
        if (!fs.existsSync(filePath)) return false;
        return await this.isValidKey(type, fs.readFileSync(filePath));
    }

    /**
     * Returns missing/invalid/ready for each imported key (used by the UI status card).
     */
    async getStatus(): Promise<FindMyKeysStatus> {
        const keys = {} as Record<FindMyKeyType, FindMyKeyState>;
        for (const type of KEY_TYPES) {
            const keyPath = this.keyPath(type);
            if (!fs.existsSync(keyPath)) {
                keys[type] = "missing";
            } else {
                keys[type] = (await this.isValidKey(type, fs.readFileSync(keyPath))) ? "ready" : "invalid";
            }
        }

        const states = Object.values(keys);
        const state = states.includes("missing") ? "missing" : states.includes("invalid") ? "invalid" : "ready";
        return { state, keys };
    }

    /**
     * Imports all three keys from a folder (e.g. findmy-key-extractor's `keys/` folder).
     *
     * The import is all-or-nothing: every key is copied into a private staging folder and
     * validated there, and only then does the staged set replace the current one. On any
     * failure the current set is left exactly as it was.
     */
    async importFromDirectory(sourceDir: string): Promise<FindMyKeyImportResult> {
        for (const type of KEY_TYPES) {
            if (!fs.existsSync(path.join(sourceDir, FIND_MY_KEY_FILES[type]))) {
                return { success: false, file: FIND_MY_KEY_FILES[type], reason: "missing" };
            }
        }

        const parentDir = path.dirname(this.keysDir);
        fs.mkdirSync(parentDir, { recursive: true });

        // Siblings of the keys folder, so the swap is a pair of same-volume renames
        const prefix = path.join(parentDir, `.${path.basename(this.keysDir)}-`);
        const stagingDir = fs.mkdtempSync(`${prefix}staging-`);
        const backupDir = `${stagingDir}-previous`;
        let keepBackup = false;
        try {
            fs.chmodSync(stagingDir, 0o700);

            for (const type of KEY_TYPES) {
                const fileName = FIND_MY_KEY_FILES[type];
                const stagedPath = path.join(stagingDir, fileName);
                let staged: Buffer;
                try {
                    fs.copyFileSync(path.join(sourceDir, fileName), stagedPath);
                    fs.chmodSync(stagedPath, 0o600);
                    staged = fs.readFileSync(stagedPath);
                } catch {
                    return { success: false, file: fileName, reason: "invalid" };
                }

                // Validate the staged copy, not the source, so what we check is what we commit
                if (!(await this.isValidKey(type, staged))) {
                    return { success: false, file: fileName, reason: "invalid" };
                }
            }

            const hadPrevious = fs.existsSync(this.keysDir);
            try {
                if (hadPrevious) this.rename(this.keysDir, backupDir);
                this.rename(stagingDir, this.keysDir);
            } catch {
                if (hadPrevious && fs.existsSync(backupDir)) {
                    try {
                        fs.rmSync(this.keysDir, { recursive: true, force: true });
                        this.rename(backupDir, this.keysDir);
                    } catch {
                        // Never delete the only remaining copy of the previous keys
                        keepBackup = true;
                    }
                }
                return { success: false, file: this.keysDir, reason: "commit-failed" };
            }

            // Only after the commit, so a failed import keeps serving the previous keys
            this.clearCache();
            return { success: true };
        } finally {
            fs.rmSync(stagingDir, { recursive: true, force: true });
            if (!keepBackup) fs.rmSync(backupDir, { recursive: true, force: true });
        }
    }
}
