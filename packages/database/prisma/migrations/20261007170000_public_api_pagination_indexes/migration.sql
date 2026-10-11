-- Match tenant visibility and the deterministic public-list keyset ordering.
CREATE INDEX "Job_public_page_idx" ON "Job"("organizationId", "status", "createdAt" DESC, "id" DESC);
CREATE INDEX "Candidate_public_page_idx" ON "Candidate"("organizationId", "createdAt" DESC, "id" DESC);
