-- PostgreSQL truncates long identifiers; align the stored index name with Prisma's generated name.
ALTER INDEX "WorkspaceInvitation_organizationId_email_acceptedAt_revokedAt_i"
RENAME TO "WorkspaceInvitation_organizationId_email_acceptedAt_revoked_idx";
