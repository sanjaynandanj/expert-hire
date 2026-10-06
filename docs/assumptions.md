# Assumptions

- Northstar is a temporary codename and is not trademark-cleared.
- The work is a clean-room product, not an exact visual or textual reproduction.
- PostgreSQL is authoritative; search indexes and analytics stores are derived.
- A user can belong to multiple organizations.
- Agency clients remain sub-workspaces under the agency tenant.
- University staff and students share one university tenant with different roles.
- AI and integrity outputs remain advisory.
- External providers have local substitutes for development and CI.
- Google, Microsoft, Stripe, voice, and production object storage require customer-owned credentials later.
# Assumptions and decisions

## Local S3 implementation

The local development stack uses SeaweedFS in one-node `weed mini` mode. MinIO Community changed to source-only distribution and its current prebuilt AIStor image requires a separate licensing decision, so it is no longer a dependable zero-setup Docker default. Northstar depends on an S3-compatible provider contract rather than vendor-specific APIs; production may use AWS S3, MinIO AIStor, or another compatible service after security and licensing review.

## Candidate decisions and scoring

The local evaluator exists only to exercise persistence, reports, and reviewer flows with reproducible sample output. Production evaluation requires a validated rubric model, job-relevance review, accessibility checks, bias/adverse-impact evaluation, and human decision controls.
