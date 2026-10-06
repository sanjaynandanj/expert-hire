# Architecture

Northstar is a pnpm/Turborepo monorepo. Next.js renders the public and role-specific web experiences. Fastify owns the versioned external and internal API. PostgreSQL is the source of truth; Prisma provides the schema and generated client. Redis/BullMQ will own background assessment work. SeaweedFS supplies local S3-compatible object storage, and Mailpit captures local mail. The storage provider contract is compatible with AWS S3 and licensed MinIO AIStor deployments.

```text
Browser → Next.js web → Fastify API → PostgreSQL
                         ├─ Redis/BullMQ workers
                         ├─ S3-compatible media
                         ├─ email provider/Mailpit
                         └─ AI, speech, billing and code-runner adapters
```

## Architectural decisions

- One web deployment initially reduces duplicated UI infrastructure while routes preserve distinct recruiter, campus, candidate, and public experiences.
- The API is a separate service so browser UI, MCP, extension, and public consumers share authorization and business rules.
- Provider interfaces must expose deterministic local implementations.
- Untrusted code must never run in the API process.
- `organizationId` is mandatory on tenant-owned roots and must come from verified identity context in production.
