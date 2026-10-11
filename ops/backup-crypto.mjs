import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const magic = Buffer.from("NSBKP001");
const headerLength = magic.length + 12;
const tagLength = 16;

function validateKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Backup key must be exactly 32 random bytes.");
}

export async function encryptBackup(input, outputPath, key) {
  validateKey(key);
  const output = await open(outputPath, "wx", 0o600);
  try {
    const iv = randomBytes(12);
    const header = Buffer.concat([magic, iv]);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(header);
    let started = false;
    const envelope = new Transform({
      transform(chunk, _encoding, callback) {
        if (!started) { this.push(header); started = true; }
        callback(null, chunk);
      },
      flush(callback) {
        if (!started) this.push(header);
        callback(null, cipher.getAuthTag());
      }
    });
    await pipeline(input, cipher, envelope, output.createWriteStream());
  } catch (error) {
    await output.close();
    await unlink(outputPath);
    throw error;
  } finally {
    await output.close();
  }
}

/** Never feed this plaintext to a restore until this promise has authenticated the entire archive. */
export async function decryptBackup(inputPath, outputPath, key) {
  validateKey(key);
  const input = await open(inputPath, "r");
  let output;
  try {
    const { size } = await input.stat();
    if (size <= headerLength + tagLength) throw new Error("Backup archive is truncated.");
    const header = Buffer.alloc(headerLength);
    await input.read(header, 0, header.length, 0);
    if (!header.subarray(0, magic.length).equals(magic)) throw new Error("Unsupported backup archive format.");
    const tag = Buffer.alloc(tagLength);
    await input.read(tag, 0, tag.length, size - tagLength);
    const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(magic.length));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    output = await open(outputPath, "wx", 0o600);
    await pipeline(input.createReadStream({ start: headerLength, end: size - tagLength - 1 }), decipher, output.createWriteStream());
  } catch (error) {
    if (output) { await output.close(); await unlink(outputPath); }
    throw error;
  } finally {
    await output?.close();
    await input.close();
  }
}

export function restoreTarget(source, target, confirmation) {
  const sourceUrl = new URL(source);
  const targetUrl = new URL(target);
  const name = decodeURIComponent(targetUrl.pathname.slice(1));
  if (!/^northstar_restore_[a-zA-Z0-9_]+$/.test(name) || name.length > 63 || confirmation !== name) throw new Error("Restore requires an explicitly confirmed northstar_restore_* database.");
  if (sourceUrl.hostname === targetUrl.hostname && (sourceUrl.port || "5432") === (targetUrl.port || "5432") && sourceUrl.pathname === targetUrl.pathname) throw new Error("Restore target must not be the source database.");
  return name;
}
