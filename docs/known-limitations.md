# Known limitations

The application is a working development build. It is not ready for production hiring decisions or handling real candidate data.

- The brand name is temporary and has not had a trademark review.
- Seeded user accounts share a known demo password and are now rejected in production; the seed command refuses to run in production. Membership-based organization switching and server-side session revocation (including logout-all) work. Registration, invitations, email verification, password reset, OAuth, MFA, and account recovery still need a real identity/email provider.
- Sessions are signed 12-hour HTTP-only cookies backed by revocable server-side records. Cross-origin state-changing requests are rejected. Production still needs managed secret rotation, full CSRF/CORS/CSP review, secure host configuration, and an external security review.
- Employer jobs, candidates, pipeline, assessments, reports, client accounts, candidate notes, meetings, basic analytics, and university placement paths use tenant-scoped database records. Meeting invitations are not delivered to external calendars, analytics currently reports live totals rather than historical cohorts, and settings/staffing placement-invoice pages still contain incomplete workflows.
- Job status is editable in the UI, and the API can update weighted requirements and round plans. A complete rubric/round-plan editor and safe round retirement UI are still missing.
- Client creation, status, fee model, billing contact, and guarantee fields are stored. Fee changes are API-backed but do not yet have a full edit experience, and placements/invoices are not calculated from actual candidate starts.
- Candidate written answers are autosaved in that browser's local storage and uploaded on final submission. Server-side draft autosave/resume, file upload, resume parsing, speech, transcription, real interview scheduling, video, and device-permission checks are incomplete.
- The local evaluator uses deterministic lexical coverage to demonstrate traceable scoring. It is not an assessment model, has not been validated for job relevance or adverse impact, must not be used to make hiring decisions, and is disabled for production submissions and worker execution.
- Integrity events are coarse browser focus-change context. They do not establish misconduct, and the product never takes an automatic hiring action from them.
- Coding assessments have no isolated execution environment. Never execute candidate code on the API or worker host.
- University staff can author/publish drives, review applications, issue offers, and record acceptance/joining outcomes; students can apply to eligible open drives. Season/company management, bulk imports, historical reconciliation, and complete offer-cap controls are incomplete.
- Candidate practice persists text attempts for three categories (technical reasoning, communication, and behavioral reflection). Resume review, coding execution, speech, pitch, prompt-lab tools, and validated readiness models are not implemented; demo visitors see non-persisted preview data.
- Credits can be read and debited to the immutable ledger. Checkout is a local fake provider; no money is collected and no paid credit grant is wired. Checkout requests fail closed in production until a real provider is integrated.
- API-key and webhook tables/interfaces exist, but key issuance/authentication, signatures, destination safety, delivery, retries, and replay are incomplete.
- The S3-compatible local store is SeaweedFS. Production storage, private ACLs, malware scanning, lifecycle retention, and signed file URLs still need implementation.
- Local Docker services and tests use fictional data. No production load, accessibility certification, penetration test, disaster-recovery exercise, or legal review has been completed.
