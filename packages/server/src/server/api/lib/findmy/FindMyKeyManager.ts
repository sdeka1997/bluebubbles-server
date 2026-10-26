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

export type FindMyKeyManagerOptions = {
    keysDir: string;
    validate: FindMyKeyValidator;
    /** Overridable for tests, to inject a fault mid-swap */
    rename?: (from: string, to: string) => void;
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

    private readonly validate: FindMyKeyValidator;

    private readonly rename: (from: string, to: string) => void;

    constructor(options: FindMyKeyManagerOptions) {
        this.keysDir = options.keysDir;
        this.validate = options.validate;
        this.rename = options.rename ?? fs.renameSync;
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
                fs.copyFileSync(path.join(sourceDir, fileName), stagedPath);
                fs.chmodSync(stagedPath, 0o600);

                // Validate the staged copy, not the source, so what we check is what we commit
                const data = fs.readFileSync(stagedPath);
                if (!isStructurallyValid(type, data)) {
                    return { success: false, file: fileName, reason: "invalid" };
                }

                try {
                    await this.validate(type, data);
                } catch {
                    // The hook's message may describe key material, so it is never surfaced
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

            return { success: true };
        } finally {
            fs.rmSync(stagingDir, { recursive: true, force: true });
            if (!keepBackup) fs.rmSync(backupDir, { recursive: true, force: true });
        }
    }
}
