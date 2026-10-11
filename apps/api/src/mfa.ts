import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(value: Buffer) {
  let bits = 0;
  let buffer = 0;
  let output = "";
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function base32Decode(value: string) {
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const character of value.toUpperCase().replace(/=+$/g, "")) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error("Invalid base32 secret");
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function encryptionKey() {
  const configured = process.env.MFA_ENCRYPTION_KEY;
  if (process.env.NODE_ENV === "production" && (!configured || configured.length < 32)) {
    throw new Error("MFA_ENCRYPTION_KEY must be configured with at least 32 characters in production");
  }
  return scryptSync(configured ?? "local-development-mfa-encryption-key", "northstar-mfa-v1", 32);
}

export function createTotpSecret() {
  return base32Encode(randomBytes(20));
}

export function totpUri(secret: string, email: string) {
  const label = encodeURIComponent(`Northstar:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Northstar&algorithm=SHA1&digits=6&period=30`;
}

export function encryptTotpSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptTotpSecret(value: string) {
  const [version, ivValue, tagValue, encryptedValue] = value.split(":");
  if (version !== "v1" || !ivValue || !tagValue || !encryptedValue) throw new Error("Invalid encrypted MFA secret");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}

export function verifyTotp(secret: string, code: string, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(now / 30_000);
  for (const offset of [-1, 0, 1]) {
    const candidate = totpForCounter(key, counter + offset);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) return true;
  }
  return false;
}

function totpForCounter(key: Buffer, counter: number) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const index = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[index]! & 0x7f) << 24) | ((digest[index + 1]! & 0xff) << 16) | ((digest[index + 2]! & 0xff) << 8) | (digest[index + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function currentTotpCode(secret: string, now = Date.now()) {
  return totpForCounter(base32Decode(secret), Math.floor(now / 30_000));
}

export function createRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => randomBytes(8).toString("hex").toUpperCase().match(/.{1,4}/g)!.join("-"));
}
