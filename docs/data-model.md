# Data model

The Prisma schema is the authoritative model. Important roots are:

- `User`, `Organization`, `Membership`: identity, tenant, and role.
- `Client`, `Job`, `Requirement`, `Round`: commercial workspace and hiring rubric.
- `Candidate`, `CandidateJob`, `PipelineStage`: talent pool and ATS state.
- `Assessment`, `ScoreEvidence`, `IntegrityEvent`: candidate session and reviewable result.
- `CreditLedger`, `AuditEvent`: financial and accountability history.
- `Campus`, `Batch`, `StudentProfile`: university cohort hierarchy.
- `PlacementSeason`, `PlacementCompany`, `PlacementDrive`, `Application`, `Offer`: placement ERP.
- `ApiKey`, `WebhookEndpoint`: developer platform foundations.

Tenant-owned queries must include an organization predicate even when an object ID appears globally unique. Cross-tenant misses should return not-found rather than disclosing existence.
