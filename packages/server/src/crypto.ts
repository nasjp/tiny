import crypto from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function decodeKey(e2eKeyB64: string): Buffer {
  const key = Buffer.from(e2eKeyB64, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(`e2eKey must be ${KEY_BYTES} bytes (got: ${key.length})`);
  }
  return key;
}

/**
 * Seals plaintext with the device's e2eKey.
 * The return value is base64 of nonce(12) ‖ ciphertext ‖ tag(16), a byte layout Apple CryptoKit's
 * `ChaChaPoly.SealedBox(combined:)` accepts as-is.
 * The Phase 3 Notification Service Extension only needs to call `ChaChaPoly.open`.
 */
export function sealForDevice(e2eKeyB64: string, plaintext: string): string {
  const key = decodeKey(e2eKeyB64);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64");
}

/** Inverse of `sealForDevice`. For tests and diagnostics (production decryption happens on iOS). */
export function openSealed(e2eKeyB64: string, combinedB64: string): string {
  const key = decodeKey(e2eKeyB64);
  const buf = Buffer.from(combinedB64, "base64");
  if (buf.length < NONCE_BYTES + TAG_BYTES) throw new Error("sealed data is too short");
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const ciphertext = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
