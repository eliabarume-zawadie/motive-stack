import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * The only place in the application that encrypts or decrypts credential material.
 *
 * AES-256-GCM (authenticated encryption). Every call uses a fresh random 96-bit nonce. Each credential has its OWN random data key
 * that encrypts exactly one secret, so a nonce is never reused under a data key; master keys wrap only 32-byte data keys, so
 * random-nonce collision risk stays negligible at any plausible volume (and rotation resets it).
 *
 * The associated data (AAD) binds a ciphertext to its context (workspace, credential id, kind). Moving a ciphertext to another
 * workspace, credential or kind fails authentication.
 *
 * Layout of a sealed value:  nonce (12) | tag (16) | ciphertext.
 */
export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ALGORITHM = "aes-256-gcm";

/** Never carries secret material or a hint about why: callers get the same message for every failure. */
export class CredentialCryptoError extends Error {
  constructor() {
    super("credential could not be authenticated or decrypted");
    this.name = "CredentialCryptoError";
  }
}

export const newDataKey = (): Buffer => randomBytes(KEY_BYTES);

export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new CredentialCryptoError();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]);
}

export function open(key: Buffer, sealed: Buffer, aad: Buffer): Buffer {
  if (key.length !== KEY_BYTES || !Buffer.isBuffer(sealed) || sealed.length <= NONCE_BYTES + TAG_BYTES) throw new CredentialCryptoError();
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ct = sealed.subarray(NONCE_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new CredentialCryptoError(); // wrong key, wrong context, or modified bytes: indistinguishable on purpose
  }
}

/** Best-effort wipe of key material held in a Buffer. (JavaScript strings cannot be wiped, so secrets travel as Buffers.) */
export const wipe = (...bufs: Array<Buffer | undefined>): void => {
  for (const b of bufs) b?.fill(0);
};
