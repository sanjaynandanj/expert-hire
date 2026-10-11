import { describe, expect, it } from "vitest";
import { createRecoveryCodes, createTotpSecret, decryptTotpSecret, encryptTotpSecret, verifyTotp } from "./mfa";

describe("TOTP MFA helpers", () => {
  it("verifies RFC 6238 SHA-1 vectors using six-digit codes", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(verifyTotp(secret, "287082", 59_000)).toBe(true);
    expect(verifyTotp(secret, "287083", 59_000)).toBe(false);
  });

  it("encrypts secrets and creates unique recovery codes", () => {
    const secret = createTotpSecret();
    expect(decryptTotpSecret(encryptTotpSecret(secret))).toBe(secret);
    const codes = createRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((code) => /^[A-F0-9]{4}(-[A-F0-9]{4}){3}$/.test(code))).toBe(true);
  });
});
