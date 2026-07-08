import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, parseEncryptionKey } from "./token-cipher";

const testKey = parseEncryptionKey(Buffer.alloc(32, 7).toString("base64"));

describe("token-cipher", () => {
  it("round-trips a plaintext token", () => {
    const payload = encryptToken("gho_super-secret-refresh-token", testKey);
    expect(decryptToken(payload, testKey)).toBe("gho_super-secret-refresh-token");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptToken("same-input", testKey);
    const b = encryptToken("same-input", testKey);
    expect(a).not.toBe(b);
  });

  it("throws on a tampered payload (auth tag mismatch)", () => {
    const payload = encryptToken("tamper-test", testKey);
    const [iv, authTag, ciphertext] = payload.split(".");
    const tampered = [iv, authTag, ciphertext.slice(0, -4) + "AAAA"].join(".");
    expect(() => decryptToken(tampered, testKey)).toThrow();
  });

  it("rejects a key that isn't exactly 32 bytes", () => {
    expect(() => parseEncryptionKey(Buffer.alloc(16).toString("base64"))).toThrow();
  });
});
