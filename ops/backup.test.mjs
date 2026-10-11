import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { decryptBackup, encryptBackup, restoreTarget } from "./backup-crypto.mjs";

test("backup encryption authenticates a private streamed round trip", async () => {
  const dir = await mkdtemp(join(tmpdir(), "northstar-backup-test-"));
  try {
    const key = randomBytes(32);
    const original = Buffer.from("PGDMP fictional audit, consent, and credit ledger\n".repeat(10000));
    const archive = join(dir, "archive.enc");
    await encryptBackup(Readable.from([original.subarray(0, 40), original.subarray(40)]), archive, key);
    assert.equal((await stat(archive)).mode & 0o777, 0o600);
    assert.equal((await readFile(archive)).includes(Buffer.from("fictional audit")), false);
    await decryptBackup(archive, join(dir, "verified.dump"), key);
    assert.deepEqual(await readFile(join(dir, "verified.dump")), original);
    await assert.rejects(encryptBackup(Readable.from(["replacement"]), archive, key), { code: "EEXIST" });
    for (const [name, transform] of [
      ["header", (data) => { data[0] ^= 1; return data; }],
      ["ciphertext", (data) => { data[25] ^= 1; return data; }],
      ["tag", (data) => { data[data.length - 1] ^= 1; return data; }],
      ["truncated", (data) => data.subarray(0, 15)]
    ]) {
      const modified = transform(Buffer.from(await readFile(archive)));
      await writeFile(join(dir, `${name}.enc`), modified);
      const plaintext = join(dir, `${name}.dump`);
      await assert.rejects(decryptBackup(join(dir, `${name}.enc`), plaintext, key));
      await assert.rejects(stat(plaintext), { code: "ENOENT" });
    }
    await assert.rejects(decryptBackup(archive, join(dir, "wrong-key.dump"), randomBytes(32)));
    await assert.rejects(stat(join(dir, "wrong-key.dump")), { code: "ENOENT" });
    await assert.rejects(encryptBackup(Readable.from(["test"]), join(dir, "bad-key.enc"), Buffer.alloc(16)));
    const failing = Readable.from((async function* () { yield "partial"; throw new Error("dump failed"); })());
    await assert.rejects(encryptBackup(failing, join(dir, "partial.enc"), key), /dump failed/);
    await assert.rejects(stat(join(dir, "partial.enc")), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("restore refuses production names, mismatched confirmation, and the source", () => {
  const source = "postgresql://user@localhost/northstar";
  assert.equal(restoreTarget(source, "postgresql://user@localhost/northstar_restore_drill", "northstar_restore_drill"), "northstar_restore_drill");
  assert.throws(() => restoreTarget(source, source, "northstar"));
  assert.throws(() => restoreTarget(source, "postgresql://user@localhost/northstar_restore_drill", "wrong"));
  assert.throws(() => restoreTarget("postgresql://user@localhost/northstar_restore_drill", "postgresql://user@localhost/northstar_restore_drill", "northstar_restore_drill"));
});
