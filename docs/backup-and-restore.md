# Encrypted database backups and isolated restore drills

The local tool streams a PostgreSQL custom-format archive into AES-256-GCM authenticated encryption. Backups use private permissions, a fresh random nonce, an authenticated format header, and a raw 32-byte key. An existing output is never overwritten. Dump failure removes the newly created incomplete output. The encryption follows Node's [authenticated-cipher API](https://nodejs.org/docs/latest-v24.x/api/crypto.html); independent security review remains required.

Run from the repository root with Node 24+. Native operation requires compatible `pg_dump`, `pg_restore`, and `psql` on PATH. `--docker` uses the local Compose `postgres` service and rejects remote hosts/non-default ports. It is not a production transport. Native remote connections require `sslmode=verify-full`; provide the appropriate CA/client certificate settings through libpq environment variables or URL options. Credentials are passed through process environment, not command arguments; restrict access to the operator host and logs.

Generate a private key outside the repository and keep a separately protected recovery copy:

```bash
node ops/database-backup.mjs keygen /secure/secrets/database-backup.key
export BACKUP_KEY_FILE=/secure/secrets/database-backup.key
```

The key must be an owner-only regular file (600 or 400), not a symlink. Supply `DATABASE_URL` from your secret manager; the development default is the fictional local database. Create a private backup directory before running:

```bash
node ops/database-backup.mjs backup /secure/backups/2026-10-07.nsbackup
node ops/database-backup.mjs verify /secure/backups/2026-10-07.nsbackup
```

Append `--docker` to backup/verify/restore commands for the local development stack. Do not commit archives or keys. Losing the key makes encrypted archives unrecoverable. Verification authenticates the entire ciphertext and reads the PostgreSQL table of contents, but it is not a substitute for restoring and checking records.

For a drill, create a separate, empty database such as `northstar_restore_drill_20261007`, using restricted network access and a dedicated restore role. Set `RESTORE_DATABASE_URL` explicitly; the tool never defaults a restore to the source connection. Confirm the exact isolated name:

```bash
node ops/database-backup.mjs restore /secure/backups/2026-10-07.nsbackup \
  --confirm=northstar_restore_drill_20261007
```

Restores require a `northstar_restore_*` name, reject the source database, reject populated targets, never request `--clean` or `--create`, and use [PostgreSQL's single-transaction restore](https://www.postgresql.org/docs/current/app-pgrestore.html) with owner/privilege restoration disabled. Source grants/roles must be recreated separately during a real recovery. Only restore archives from trusted operators: a PostgreSQL dump can contain executable database code. Encryption authenticates possession of the key; it does not establish that SQL is safe.

Plaintext is authenticated in a private temporary directory before any restore process starts and is deleted on controlled success/failure. Provide enough temporary disk space, preferably on an encrypted temporary volume via `TMPDIR`. Abrupt power loss or SIGKILL can leave a private plaintext staging directory; include its cleanup in the operator runbook and host-disk security policy. Authentication failures delete the newly created plaintext. SIGINT/SIGTERM stop active child processes and prevent starting a later restore phase.

After restoration, compare table counts and ordered contents for audit events, assessment consent/evidence, and credit ledgers; inspect foreign keys/indexes and run read-only application checks. Keep the restored environment isolated, with API/worker/webhook/email delivery disabled, to avoid replaying notifications or using restored session credentials. Destroy a disposable drill database only after recording results and confirming its exact identity.

A local drill restored the fictional database and matched ordered fingerprints for `AuditEvent`, `Assessment` (including consent fields), `CreditLedger`, and `ScoreEvidence`; a second restore correctly refused the populated target. Crypto tests cover wrong keys, modified header/ciphertext/tag, truncation, existing-output protection, and interrupted input streams:

```bash
node --test ops/backup.test.mjs
```

This is logical backup/drill tooling, not a deployed production backup system. Configure independent scheduled collection, off-host versioned/immutable retention, key escrow/rotation, freshness/failure alerts, and periodic recovery exercises. Define recovery-time/recovery-point targets with the operator. [PostgreSQL recommends broader production backup planning](https://www.postgresql.org/docs/current/app-pgdump.html); add managed snapshots/WAL point-in-time recovery and separate object-storage backups as appropriate. No production infrastructure, retention policy, or object-storage snapshot integration is provisioned by this tool.
