import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function parseEncryptionKey(keySource) {
  const decoded = Buffer.from(keySource, "base64");
  if (decoded.length === 32) return decoded;
  return createHash("sha256").update(keySource, "utf8").digest();
}

let key = null;

function getKey() {
  if (key) return key;
  const keySource = process.env.TOKEN_ENCRYPTION_KEY ?? process.env.EMAIL_ENCRYPTION_KEY;
  if (!keySource) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY or EMAIL_ENCRYPTION_KEY must be set in apps/api/.env"
    );
  }
  key = parseEncryptionKey(keySource);
  return key;
}

export function encryptToken(plaintext) {
  const encryptionKey = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptToken(payload) {
  const encryptionKey = getKey();
  const [ivB64, authTagB64, ciphertextB64] = payload.split(".");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted token payload");
  }
  const decipher = createDecipheriv(ALGORITHM, encryptionKey, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
