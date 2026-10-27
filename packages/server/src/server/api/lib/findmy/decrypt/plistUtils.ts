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
            root = bplist.parseBuffer(widenInt64Objects(buffer))[0];
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
 * bplist-parser 0.3.2 folds integers into a 32-bit JS int, so an 8-byte integer (the epoch-ms
 * timestamps in the 14.4+ FMIP caches) comes back truncated and reads as a January 1970 date.
 * Returns a copy in which every 8-byte integer object is rewritten as an 8-byte real holding
 * the same value: the object keeps its size, so no offset moves, and bplist-parser decodes
 * reals exactly up to 2^53. A malformed trailer is left for bplist-parser to reject.
 */
const widenInt64Objects = (buffer: Buffer): Buffer => {
    const trailer = buffer.length - 32;
    if (trailer < 8) return buffer;
    const offsetSize = buffer.readUInt8(trailer + 6);
    // Read the trailer as bplist-parser does: the low 32 bits of each 64-bit field
    const numObjects = buffer.readUInt32BE(trailer + 12);
    const offsetTable = buffer.readUInt32BE(trailer + 28);
    if (offsetSize < 1 || offsetSize > 8 || offsetTable + numObjects * offsetSize > trailer) return buffer;

    let widened: Buffer | null = null;
    for (let i = 0; i < numObjects; i++) {
        let offset = 0;
        for (let b = 0; b < offsetSize; b++) offset = offset * 256 + buffer[offsetTable + i * offsetSize + b];
        // 0x13: integer, 2^3 bytes, big-endian two's complement
        if (buffer[offset] !== 0x13 || offset + 9 > trailer) continue;
        if (!widened) widened = Buffer.from(buffer);
        widened[offset] = 0x23; // real, 2^3 bytes
        widened.writeDoubleBE(Number(buffer.readBigInt64BE(offset + 1)), offset + 1);
    }
    return widened ?? buffer;
};

/**
 * Read a plist file (binary or XML) through readCacheFile.
 */
export const parsePlistFile = (filePath: string): any => parsePlistBuffer(readCacheFile(filePath));

/**
 * Read a Find My cache or key file. The path is opened without following symlinks and must be
 * a regular file within MAX_PLIST_BYTES: a symlink to a device would otherwise block the
 * synchronous read forever.
 */
export const readCacheFile = (filePath: string): Buffer => {
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
        return fs.readFileSync(fd);
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
