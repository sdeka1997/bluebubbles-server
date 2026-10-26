import path from "path";
import { decryptCacheBuffer } from "./cache";
import { readCacheFile } from "./plistUtils";

export const FMF_CACHE_FILE = "FriendCacheData.data";

/**
 * Reads and decrypts the FMF cache (`FriendCacheData.data`) and returns the complete payload:
 * `following`, `followers`, `contacts`, `myInfo` and whatever else Apple stores, with "$null"
 * normalized to null. Building the roster from it is the caller's job.
 *
 * @param fmfKey 32-byte FMF ChaCha20 key
 * @param fmfCacheDir Directory holding the cache (FileSystem.findMyFmfCacheDir in production)
 */
export const readFmfRosterData = (fmfKey: Buffer, fmfCacheDir: string): Record<string, any> =>
    decryptCacheBuffer(readCacheFile(path.join(fmfCacheDir, FMF_CACHE_FILE)), fmfKey);
