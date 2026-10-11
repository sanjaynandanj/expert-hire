import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { decryptBackup, encryptBackup, restoreTarget } from "./backup-crypto.mjs";

const sourceUrl = process.env.DATABASE_URL ?? "postgresql://northstar:northstar@localhost:5432/northstar";
const [command, file, ...flags] = process.argv.slice(2);
const docker = flags.includes("--docker");
const active = new Set();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { interrupted = true; process.exitCode = 130; for (const child of active) child.kill("SIGTERM"); });

function pgTool(tool, args, connection) {
  if (interrupted) throw new Error("Backup operation was interrupted.");
  const url = new URL(connection);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("A PostgreSQL connection URL is required.");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (docker && (!local || (url.port && url.port !== "5432"))) throw new Error("--docker is only for the local Compose PostgreSQL service on port 5432.");
  const sslmode = url.searchParams.get("sslmode") ?? process.env.PGSSLMODE ?? (local ? "disable" : "verify-full");
  if (!local && sslmode !== "verify-full") throw new Error("Remote backup/restore connections require sslmode=verify-full.");
  const env = { ...process.env, PGHOST: docker ? "127.0.0.1" : url.hostname.replace(/^\[|\]$/g, ""), PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: sslmode, PGCONNECT_TIMEOUT: "10" };
  for (const name of ["sslrootcert", "sslcert", "sslkey"]) if (url.searchParams.has(name)) env[`PG${name.toUpperCase()}`] = url.searchParams.get(name);
  const forwarded = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSSLMODE", "PGCONNECT_TIMEOUT"].flatMap((name) => ["-e", name]);
  const child = spawn(docker ? "docker" : tool, docker ? ["compose", "exec", "-T", ...forwarded, "postgres", tool, ...args] : args, { env, stdio: ["pipe", "pipe", "pipe"], timeout: 900_000 });
  active.add(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const finished = new Promise((resolveDone, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      active.delete(child);
      if (code === 0) resolveDone();
      else {
        const safeError = env.PGPASSWORD ? stderr.split(env.PGPASSWORD).join("[redacted]") : stderr;
        reject(new Error(`${tool} failed (exit ${code}): ${safeError.trim()}`));
      }
    });
  });
  // The caller may be streaming a large archive before awaiting process exit.
  void finished.catch(() => {});
  return { child, finished };
}

async function keyBytes() {
  if (!process.env.BACKUP_KEY_FILE) throw new Error("BACKUP_KEY_FILE must point to a private, raw 32-byte key file.");
  const handle = await open(process.env.BACKUP_KEY_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error("Backup key must be an owner-only regular file (mode 600 or 400).");
    const key = await handle.readFile();
    if (key.length !== 32) throw new Error("Backup key must contain exactly 32 raw bytes.");
    return key;
  } finally { await handle.close(); }
}

async function query(connection, sql) {
  const { child, finished } = pgTool("psql", ["-X", "--no-password", "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1", "--command", sql], connection);
  child.stdin.end();
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  await finished;
  return output.trim();
}

async function main() {
  if (!file || !["keygen", "backup", "verify", "restore"].includes(command)) throw new Error("Usage: node ops/database-backup.mjs keygen KEY | backup ARCHIVE [--docker] | verify ARCHIVE [--docker] | restore ARCHIVE --confirm=northstar_restore_NAME [--docker]");
  const path = resolve(file);
  if (command === "keygen") {
    await writeFile(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    console.log("Created private backup key. Store it separately from backups; losing it makes archives unrecoverable.");
    return;
  }
  const key = await keyBytes();
  if (command === "backup") {
    const { child, finished } = pgTool("pg_dump", ["--format=custom", "--no-password"], sourceUrl);
    child.stdin.end();
    const encrypted = encryptBackup(child.stdout, path, key).catch((error) => { child.kill("SIGTERM"); throw error; });
    const outcomes = await Promise.allSettled([encrypted, finished]);
    if (outcomes.some((result) => result.status === "rejected")) {
      if (outcomes[0].status === "fulfilled") await unlink(path);
      throw outcomes.find((result) => result.status === "rejected").reason;
    }
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    console.log(JSON.stringify({ operation: "backup", format: "NSBKP001", encryptedBytes: (await stat(path)).size }));
    return;
  }
  const target = process.env.RESTORE_DATABASE_URL;
  const confirmation = flags.find((flag) => flag.startsWith("--confirm="))?.slice("--confirm=".length);
  if (command === "restore") {
    if (!target) throw new Error("RESTORE_DATABASE_URL is required; source DATABASE_URL is never a restore default.");
    restoreTarget(sourceUrl, target, confirmation);
  }
  // Authenticated plaintext is staged privately and removed after success or failure.
  const directory = await mkdtemp(join(tmpdir(), "northstar-restore-"));
  const plaintext = join(directory, "verified.dump");
  try {
    await decryptBackup(path, plaintext, key);
    const handle = await open(plaintext, "r");
    try {
      const signature = Buffer.alloc(5);
      await handle.read(signature, 0, signature.length, 0);
      if (signature.toString() !== "PGDMP") throw new Error("Authenticated payload is not a PostgreSQL custom archive.");
    } finally { await handle.close(); }
    if (command === "restore") {
      const count = await query(target, "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','S','f');");
      if (count !== "0") throw new Error("Restore target is not empty. No existing data will be overwritten.");
    }
    const args = command === "verify" ? ["--list"] : ["--no-password", "--single-transaction", "--no-owner", "--no-privileges", "--dbname", restoreTarget(sourceUrl, target, confirmation)];
    const { child, finished } = pgTool("pg_restore", args, command === "restore" ? target : sourceUrl);
    child.stdout.resume();
    const streamed = pipeline(createReadStream(plaintext), child.stdin).catch((error) => { child.kill("SIGTERM"); throw error; });
    await Promise.all([streamed, finished]);
    console.log(JSON.stringify({ operation: command, authenticated: true, plaintextBytes: (await stat(plaintext)).size }));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Backup operation failed."); process.exitCode = 1; });
