import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { parsePlistBuffer } from "./plistUtils";

// Real FMF/FMIP cache files are tens to hundreds of KB. The cap bounds memory and how long
// the synchronous decrypt and plist parse can block the main thread on a hostile file.
export const MAX_FIND_MY_CACHE_BYTES = 16 * 1024 * 1024;

const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Apple's Find My plists use the literal string "$null" as a null placeholder. The legacy
 * plaintext cache (read directly as JSON) used real `null`s, and the BlueBubbles clients
 * expect nullable strings — so recursively replace "$null" with null to match that shape.
 */
export const normalizePlistNulls = (value: any): any => {
    if (value === "$null") return null;
    if (Array.isArray(value)) return value.map(normalizePlistNulls);
    if (value && typeof value === "object" && !Buffer.isBuffer(value) && !(value instanceof Date)) {
        for (const k of Object.keys(value)) {
            value[k] = normalizePlistNulls(value[k]);
        }
    }
    return value;
};

/**
 * Decrypts a Find My cache payload using ChaCha20-Poly1305.
 *
 * Layout of `encryptedData`:
 *   [ 12-byte nonce ][ ciphertext ][ 16-byte Poly1305 tag ]
 *
 * Node has a native `chacha20-poly1305` cipher but Electron's BoringSSL build does not
 * (`getCiphers()` lists no chacha variant in Electron 25), so this uses @noble/ciphers.
 */
export const decryptChaCha20Poly1305 = (encryptedData: Buffer, key: Buffer): Buffer => {
    if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
        throw new Error(`Expected a ${KEY_LENGTH}-byte Find My cache key, got ${key?.length ?? 0} bytes`);
    }
    if (encryptedData.length < NONCE_LENGTH + TAG_LENGTH) {
        throw new Error(`Find My cache payload too short (${encryptedData.length} bytes)`);
    }

    const nonce = encryptedData.subarray(0, NONCE_LENGTH);
    const ciphertextWithTag = encryptedData.subarray(NONCE_LENGTH);
    const cipher = chacha20poly1305(new Uint8Array(key), new Uint8Array(nonce));
    try {
        return Buffer.from(cipher.decrypt(new Uint8Array(ciphertextWithTag)));
    } catch {
        // The Poly1305 tag doubles as the key check: a wrong key or tampered payload fails here
        throw new Error("Find My cache authentication failed (wrong key or corrupt payload)");
    }
};

/**
 * Reads a Find My cache `.data` file (a plist wrapper with an `encryptedData` blob),
 * decrypts it, and parses the plaintext (a binary plist).
 *
 * @param fileBuffer Raw contents of the `.data` file
 * @param key 32-byte ChaCha20 key (FMIP or FMF)
 */
export const decryptCacheBuffer = (fileBuffer: Buffer, key: Buffer): any => {
    if (fileBuffer.length > MAX_FIND_MY_CACHE_BYTES) {
        throw new Error(`Find My cache file too large (${fileBuffer.length} bytes)`);
    }

    const wrapper = parsePlistBuffer(fileBuffer);
    const encryptedData = wrapper?.encryptedData;
    if (!Buffer.isBuffer(encryptedData)) throw new Error("Find My cache file has no encryptedData blob");

    const decrypted = decryptChaCha20Poly1305(encryptedData, key);
    return normalizePlistNulls(parsePlistBuffer(decrypted));
};
