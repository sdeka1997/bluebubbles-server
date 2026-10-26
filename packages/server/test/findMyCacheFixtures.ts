import { chacha20poly1305 } from "@noble/ciphers/chacha";
import plist from "plist";

/** Test-only builders for Apple's ChaCha20-Poly1305 Find My cache files (FMIP/FMF `.data`). */

export const CACHE_KEY = Buffer.alloc(32, 0x11);
const NONCE = Buffer.alloc(12, 0x22);

/** Builds Apple's `[nonce][ciphertext][tag]` envelope with a fixed key and nonce. */
export const seal = (plaintext: Buffer, key: Buffer = CACHE_KEY, nonce: Buffer = NONCE): Buffer =>
    Buffer.concat([
        nonce,
        Buffer.from(chacha20poly1305(new Uint8Array(key), new Uint8Array(nonce)).encrypt(plaintext))
    ]);

/** Wraps an envelope the way Apple's `.data` cache files do: a plist with `encryptedData`. */
export const cacheFile = (envelope: Buffer): Buffer => Buffer.from(plist.build({ encryptedData: envelope } as any));

/** A complete `.data` cache file whose decrypted payload is `payload` as a plist. */
export const sealedCacheFile = (payload: any, key: Buffer = CACHE_KEY): Buffer =>
    cacheFile(seal(Buffer.from(plist.build(payload)), key));
