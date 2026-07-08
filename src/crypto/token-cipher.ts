import { Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/**
 * Envelope encryption for OAuth access/refresh tokens at rest (ConnectedAccount
 * rows) — these are live credentials into a user's carrier-dashboard/email
 * accounts, so they're never stored in plaintext. The key must be a 32-byte
 * key, base64-encoded (e.g. `openssl rand -base64 32`). In production this
 * key should come from a real KMS, not a bare env var — this is the minimal
 * viable version of that design. Exposed as pure functions (easy to unit
 * test without Nest DI) plus a thin injectable wrapper for use in services.
 */
export function parseEncryptionKey(base64Key: string): Buffer {
  const decoded = Buffer.from(base64Key, "base64");
  // Backward-compatible with old Loadline-style plain secrets:
  // if it's not a 32-byte base64 key, derive a stable 32-byte key.
  if (decoded.length === 32) return decoded;
  return createHash("sha256").update(base64Key, "utf8").digest();
}

/** Returns `${iv}.${authTag}.${ciphertext}`, each base64. */
export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptToken(payload: string, key: Buffer): string {
  const [ivB64, authTagB64, ciphertextB64] = payload.split(".");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted token payload");
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));

  return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, "base64")), decipher.final()]).toString("utf8");
}

@Injectable()
export class TokenCipherService {
  private readonly key: Buffer;

  constructor() {
    const keySource = process.env.TOKEN_ENCRYPTION_KEY ?? process.env.EMAIL_ENCRYPTION_KEY;
    if (!keySource) {
      throw new Error(
        "TOKEN_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and add it to apps/api/.env."
      );
    }
    this.key = parseEncryptionKey(keySource);
  }

  encrypt(plaintext: string): string {
    return encryptToken(plaintext, this.key);
  }

  decrypt(payload: string): string {
    return decryptToken(payload, this.key);
  }
}
