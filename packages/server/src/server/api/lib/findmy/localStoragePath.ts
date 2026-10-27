import fs from "fs";
import path from "path";

const AGENT = "com.apple.findmy.findmylocateagent";

/**
 * Places findmylocateagent keeps LocalStorage.db, in lookup order.
 * - macOS 26: the agent's group container.
 * - macOS 15: the per-user Darwin dir (`getconf DARWIN_USER_DIR`), seen on 15.8.1.
 */
export const localStorageDbCandidates = (homeDir: string, darwinUserDir: string | null): string[] => {
    const candidates = [
        path.join(homeDir, "Library", "Group Containers", `group.${AGENT}`, "Library", "Application Support", "LocalStorage.db")
    ];
    if (darwinUserDir) candidates.push(path.join(darwinUserDir, AGENT, "LocalStorage.db"));
    return candidates;
};

/** The first candidate that exists; the first one if Find My hasn't created either yet. */
export const resolveLocalStorageDbPath = (
    candidates: string[],
    exists: (p: string) => boolean = fs.existsSync
): string => candidates.find(p => exists(p)) ?? candidates[0];
