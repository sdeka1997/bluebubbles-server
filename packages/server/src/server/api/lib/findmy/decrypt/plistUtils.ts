import fs from "fs";
import plist from "plist";
import * as bplist from "bplist-parser";

// Find My plists (cache wrappers, decrypted payloads, key files) are at most a few hundred KB.
export const MAX_PLIST_BYTES = 16 * 1024 * 1024;

/**
 * Parse a plist from an in-memory buffer (binary or XML).
 *
 * @throws "malformed plist" if the buffer does not parse to a plist root object.
 */
export const parsePlistBuffer = (buffer: Buffer): any => {
    if (!Buffer.isBuffer(buffer)) throw new Error("malformed plist: expected a Buffer");
    if (buffer.length > MAX_PLIST_BYTES) throw new Error(`plist too large (${buffer.length} bytes)`);

    let root: any;
    try {
        if (buffer.toString("utf8", 0, 6) === "bplist") {
            // bplist-parser returns an array of top-level objects; the first is the root
            root = bplist.parseBuffer(buffer)[0];
        } else {
            root = plist.parse(buffer.toString("utf8"));
        }
    } catch (ex: any) {
        throw new Error(`malformed plist: ${ex?.message ?? ex}`);
    }

    if (root === null || typeof root !== "object") throw new Error("malformed plist: root is not an object");
    return root;
};

/**
 * Read a plist file (binary or XML). The path is opened without following symlinks and must
 * be a regular file within MAX_PLIST_BYTES: a symlink to a device would otherwise block the
 * synchronous read forever.
 */
export const parsePlistFile = (filePath: string): any => {
    let fd: number;
    try {
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (ex: any) {
        if (ex?.code === "ELOOP") throw new Error(`plist is not a regular file: ${filePath}`);
        throw ex;
    }

    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) throw new Error(`plist is not a regular file: ${filePath}`);
        if (stat.size > MAX_PLIST_BYTES) throw new Error(`plist too large (${stat.size} bytes)`);
        return parsePlistBuffer(fs.readFileSync(fd));
    } finally {
        fs.closeSync(fd);
    }
};

/**
 * Extracts the 32-byte ChaCha20 symmetric key from a FMIP/FMF DataManager bplist.
 *
 * The keychain bplist nests the raw key as: symmetricKey -> key -> data.
 * Older/alternate formats may store the key directly as a base64 string.
 *
 * @returns The 32-byte key buffer, or null if it could not be extracted.
 */
export const extractSymmetricKey = (plistData: any): Buffer | null => {
    const symmetricKey = plistData?.symmetricKey;
    if (!symmetricKey) return null;

    let keyBytes: Buffer | null = null;
    if (typeof symmetricKey === "object" && symmetricKey.key?.data != null) {
        const data = symmetricKey.key.data;
        keyBytes = Buffer.isBuffer(data) ? data : typeof data === "string" ? Buffer.from(data, "base64") : null;
    } else if (typeof symmetricKey === "string") {
        keyBytes = Buffer.from(symmetricKey, "base64");
    }

    if (!keyBytes || keyBytes.length !== 32) return null;
    return keyBytes;
};
