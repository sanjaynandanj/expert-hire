import { completeAssessment, persistWebhookEvent, prisma } from "@northstar/database";
import { encryptWebhookSecret } from "@northstar/providers";
import { Queue } from "bullmq";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app";
import { currentTotpCode } from "./mfa";

const enabled = process.env.ACCOUNT_FLOW_INTEGRATION === "1";
const app = enabled ? await buildApp() : null;
const createdEmail = `codex-account-flow-${Date.now()}@example.test`;
const createdStudentEmail = `codex-placement-student-${Date.now()}@example.test`;
const bulkEmails = [0, 1].map((index) => `codex-bulk-student-${Date.now()}-${index}@example.test`);

function actionToken(response: { json: () => { developmentActionUrl: string } }) {
  return new URL(response.json().developmentActionUrl).searchParams.get("token") as string;
}

function sessionCookie(response: { headers: { "set-cookie"?: string | string[] | number | undefined } }) {
  const value = response.headers["set-cookie"];
  const cookie = Array.isArray(value) ? value[0] : typeof value === "string" ? value : undefined;
  return cookie?.split(";")[0] ?? "";
}

describe.skipIf(!enabled)("account lifecycle integration", () => {
  afterAll(async () => {
    if (app) await app.close();
    const user = await prisma.user.findUnique({ where: { email: createdEmail }, select: { id: true, memberships: { select: { organizationId: true } } } });
    if (user) {
      await prisma.organization.deleteMany({ where: { id: { in: user.memberships.map((membership) => membership.organizationId) } } });
      await prisma.user.delete({ where: { id: user.id } });
    }
    await prisma.user.deleteMany({ where: { email: { in: [createdStudentEmail, ...bulkEmails] } } });
  });

  it("registers, verifies, resets a password, enrolls MFA, and enforces one-time recovery", async () => {
    expect(app).not.toBeNull();
    const readiness = await app!.inject({ method: "GET", url: "/ready" });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({ dependencies: { database: "ok", queue: "ok" } });
    const registration = await app!.inject({ method: "POST", url: "/v1/auth/register", payload: { name: "Codex Integration", email: createdEmail, password: "long-integration-password", organizationName: "Codex Integration University", organizationType: "UNIVERSITY" } });
    expect(registration.statusCode).toBe(202);
    const verification = await app!.inject({ method: "POST", url: "/v1/auth/verification/confirm", payload: { token: actionToken(registration) } });
    expect(verification.statusCode).toBe(200);

    const resetRequest = await app!.inject({ method: "POST", url: "/v1/auth/password-reset/request", payload: { email: createdEmail } });
    const reset = await app!.inject({ method: "POST", url: "/v1/auth/password-reset/confirm", payload: { token: actionToken(resetRequest), password: "updated-integration-password" } });
    expect(reset.statusCode).toBe(200);

    const login = await app!.inject({ method: "POST", url: "/v1/auth/login", payload: { email: createdEmail, password: "updated-integration-password" } });
    expect(login.statusCode).toBe(200);
    const cookie = sessionCookie(login);
    expect(cookie).toContain("northstar_session=");
    const organizationId = login.json<{ organizations: Array<{ id: string }> }>().organizations[0]!.id;
    const universityHeaders = { cookie, "x-organization-id": organizationId };
    const seasonResponse = await app!.inject({ method: "POST", url: "/v1/placements/seasons", headers: universityHeaders, payload: { name: "Integration Season", academicYear: "2099-00", offerCap: 2, upgradeMultiple: 1.5, active: true } });
    expect(seasonResponse.statusCode).toBe(201);
    const season = seasonResponse.json<{ id: string }>();
    const seasonUpdate = await app!.inject({ method: "PATCH", url: `/v1/placements/seasons/${season.id}`, headers: universityHeaders, payload: { offerCap: 3, upgradeMultiple: 2 } });
    expect(seasonUpdate.statusCode).toBe(200);
    expect(seasonUpdate.json()).toMatchObject({ offerCap: 3 });
    const bulkImport = await app!.inject({ method: "POST", url: "/v1/placements/students/import", headers: universityHeaders, payload: { students: bulkEmails.map((email, index) => ({ name: `Imported Student ${index + 1}`, email, registrationNo: `BULK-${Date.now()}-${index}`, branch: "CSE", graduationYear: 2099, cgpa: 8.5 })) } });
    expect(bulkImport.statusCode).toBe(200);
    const importedStudents = bulkImport.json<{ imported: number; created: number; invited: number; students: Array<{ email: string; actionUrl?: string }> }>();
    expect(importedStudents).toMatchObject({ imported: 2, created: 2, invited: 2 });
    const studentInviteUrl = importedStudents.students[0]?.actionUrl;
    expect(studentInviteUrl).toBeTruthy();
    const studentInviteToken = new URL(studentInviteUrl as string).searchParams.get("token");
    const acceptStudentInvitation = await app!.inject({ method: "POST", url: `/v1/auth/invitations/${studentInviteToken}/accept`, payload: { name: "Imported Student 1", password: "imported-student-password" } });
    expect(acceptStudentInvitation.statusCode).toBe(200);
    const importedStudentLogin = await app!.inject({ method: "POST", url: "/v1/auth/login", payload: { email: bulkEmails[0], password: "imported-student-password" } });
    expect(importedStudentLogin.statusCode).toBe(200);
    const selfService = await app!.inject({ method: "GET", url: "/v1/student/drives", headers: { cookie: sessionCookie(importedStudentLogin), "x-organization-id": organizationId } });
    expect(selfService.statusCode).toBe(200);
    const applicationHistory = await app!.inject({ method: "GET", url: "/v1/student/applications", headers: { cookie: sessionCookie(importedStudentLogin), "x-organization-id": organizationId } });
    expect(applicationHistory.statusCode).toBe(200);
    expect(applicationHistory.json()).toMatchObject({ object: "list", data: [] });
    const updateAcademicProfile = await app!.inject({ method: "PATCH", url: "/v1/student/profile", headers: { cookie: sessionCookie(importedStudentLogin), "x-organization-id": organizationId }, payload: { branch: "ECE", graduationYear: new Date().getFullYear() + 2, cgpa: 9.2 } });
    expect(updateAcademicProfile.statusCode).toBe(200);
    expect(updateAcademicProfile.json()).toMatchObject({ status: "PENDING_REVIEW", correction: { branch: "ECE", graduationYear: new Date().getFullYear() + 2, cgpa: 9.2 } });
    const unchangedAcademicProfile = await prisma.studentProfile.findFirstOrThrow({ where: { user: { email: bulkEmails[0]! } }, select: { branch: true, cgpa: true, profileCorrection: true } });
    expect(unchangedAcademicProfile.branch).toBe("CSE");
    expect(Number(unchangedAcademicProfile.cgpa)).toBe(8.5);
    expect(unchangedAcademicProfile.profileCorrection).toMatchObject({ branch: "ECE", cgpa: 9.2 });
    const updateImportedStudent = await app!.inject({ method: "POST", url: "/v1/placements/students/import", headers: universityHeaders, payload: { students: [{ name: "Imported Student 1", email: bulkEmails[0], registrationNo: `BULK-UPDATED-${Date.now()}`, branch: "ECE", graduationYear: 2099, cgpa: 9.1 }] } });
    expect(updateImportedStudent.statusCode).toBe(200);
    expect(updateImportedStudent.json()).toMatchObject({ imported: 1, created: 0, updated: 1, invited: 0 });
    const importedStudentProfile = await prisma.studentProfile.findFirstOrThrow({ where: { user: { email: bulkEmails[0]! } }, select: { id: true } });
    const approveAcademicCorrection = await app!.inject({ method: "PATCH", url: `/v1/placements/students/${importedStudentProfile.id}/profile-correction`, headers: universityHeaders, payload: { decision: "APPROVE" } });
    expect(approveAcademicCorrection.statusCode).toBe(200);
    expect(approveAcademicCorrection.json()).toMatchObject({ branch: "ECE", cgpa: 9.2, profileCorrection: null });
    const studentNotifications = await app!.inject({ method: "GET", url: "/v1/student/notifications", headers: { cookie: sessionCookie(importedStudentLogin), "x-organization-id": organizationId } });
    expect(studentNotifications.statusCode).toBe(200);
    const notificationList = studentNotifications.json<{ unreadCount: number; data: Array<{ id: string; type: string; readAt: string | null }> }>();
    expect(notificationList.unreadCount).toBe(1);
    expect(notificationList.data[0]).toMatchObject({ type: "profile_correction.reviewed", readAt: null });
    const markNotificationRead = await app!.inject({ method: "PATCH", url: `/v1/student/notifications/${notificationList.data[0]!.id}/read`, headers: { cookie: sessionCookie(importedStudentLogin), "x-organization-id": organizationId }, payload: {} });
    expect(markNotificationRead.statusCode).toBe(200);
    expect(markNotificationRead.json()).toMatchObject({ readAt: expect.any(String) });
    const responseCompany = await prisma.placementCompany.create({ data: { organizationId, name: "Student Offer Response Company" } });
    const responseDrive = await prisma.placementDrive.create({ data: { seasonId: season.id, companyId: responseCompany.id, title: "Offer Response Check", description: "A drive for verifying student-controlled offer decisions.", status: "PUBLISHED", jobType: "FULL_TIME", locations: ["Remote"], applyBy: new Date("2099-12-31T00:00:00.000Z"), openings: 1, eligibleBranches: ["ECE"] } });
    const responseApplication = await prisma.application.create({ data: { driveId: responseDrive.id, studentId: importedStudentProfile.id, status: "OFFERED" } });
    const responseOffer = await prisma.offer.create({ data: { applicationId: responseApplication.id, ctc: 1_500_000, currency: "INR" } });
    const acceptOffer = await app!.inject({ method: "PATCH", url: `/v1/student/offers/${responseOffer.id}`, headers: { cookie: sessionCookie(importedStudentLogin), "x-organization-id": organizationId }, payload: { status: "ACCEPTED" } });
    expect(acceptOffer.statusCode).toBe(200);
    expect(acceptOffer.json()).toMatchObject({ id: responseOffer.id, status: "ACCEPTED" });
    const acceptedHistory = await app!.inject({ method: "GET", url: "/v1/student/applications", headers: { cookie: sessionCookie(importedStudentLogin), "x-organization-id": organizationId } });
    expect(acceptedHistory.json<{ data: Array<{ id: string; status: string; offer: { id: string; status: string } | null }> }>().data).toContainEqual(expect.objectContaining({ id: responseApplication.id, status: "ACCEPTED", offer: expect.objectContaining({ id: responseOffer.id, status: "ACCEPTED" }) }));
    const studentHeaders = { cookie: sessionCookie(importedStudentLogin), "x-organization-id": organizationId };
    for (const scenario of ["student-response", "university-outcome"] as const) {
      const raceDrive = await prisma.placementDrive.create({ data: { seasonId: season.id, companyId: responseCompany.id, title: `Concurrent ${scenario}`, description: "A drive for verifying concurrent placement decisions.", status: "PUBLISHED", jobType: "FULL_TIME", locations: ["Remote"], applyBy: new Date("2099-12-31T00:00:00.000Z"), openings: 1, eligibleBranches: ["ECE"] } });
      const raceApplication = await prisma.application.create({ data: { driveId: raceDrive.id, studentId: importedStudentProfile.id, status: "OFFERED" } });
      const raceOffer = await prisma.offer.create({ data: { applicationId: raceApplication.id, ctc: 1_500_000, currency: "INR" } });
      const decisions = await Promise.all([
        app!.inject({ method: "PATCH", url: `/v1/student/offers/${raceOffer.id}`, headers: studentHeaders, payload: { status: "ACCEPTED" } }),
        scenario === "student-response"
          ? app!.inject({ method: "PATCH", url: `/v1/student/offers/${raceOffer.id}`, headers: studentHeaders, payload: { status: "DECLINED" } })
          : app!.inject({ method: "PATCH", url: `/v1/placements/offers/${raceOffer.id}`, headers: universityHeaders, payload: { status: "REVOKED" } })
      ]);
      expect(decisions.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const winner = decisions.find((response) => response.statusCode === 200)!.json<{ status: string }>();
      const stored = await prisma.offer.findUniqueOrThrow({ where: { id: raceOffer.id }, include: { application: true } });
      expect(stored.status).toBe(winner.status);
      expect(stored.application.status).toBe(winner.status === "ACCEPTED" ? "ACCEPTED" : "REJECTED");
      expect(await prisma.auditEvent.count({ where: { organizationId, entityId: raceOffer.id, action: { in: ["student.placement.offer.responded", "placement.offer.status.changed"] } } })).toBe(1);
      expect(await prisma.userNotification.count({ where: { organizationId, type: "placement.offer.updated", data: { path: ["offerId"], equals: raceOffer.id } } })).toBe(winner.status === "REVOKED" ? 1 : 0);
    }
    const reconcileStudent = await app!.inject({ method: "PATCH", url: `/v1/placements/students/${importedStudentProfile.id}/reconciliation`, headers: universityHeaders, payload: { placed: true, currentCtc: 1_200_000, currency: "INR", source: "Employer confirmation, integration fixture" } });
    expect(reconcileStudent.statusCode).toBe(200);
    expect(reconcileStudent.json()).toMatchObject({ placed: true, currentCtc: "1200000", currentCtcCurrency: "INR", placementSource: "Employer confirmation, integration fixture" });
    const companyResponse = await app!.inject({ method: "POST", url: "/v1/placements/companies", headers: universityHeaders, payload: { name: "Integration Company", tier: "STARTUP", recruiterName: "Recruiter", recruiterEmail: "recruiter@example.test" } });
    expect(companyResponse.statusCode).toBe(201);
    const company = companyResponse.json<{ id: string }>();
    const companyUpdate = await app!.inject({ method: "PATCH", url: `/v1/placements/companies/${company.id}`, headers: universityHeaders, payload: { tier: "SME" } });
    expect(companyUpdate.statusCode).toBe(200);
    const companyDelete = await app!.inject({ method: "DELETE", url: `/v1/placements/companies/${company.id}`, headers: universityHeaders });
    expect(companyDelete.statusCode).toBe(204);
    const reconciliationCompany = await prisma.placementCompany.create({ data: { organizationId, name: "Historical Reconciliation Company" } });
    const reconciliationDrive = await prisma.placementDrive.create({ data: { seasonId: season.id, companyId: reconciliationCompany.id, title: "Historical CTC Upgrade Check", description: "A drive used to verify historical placement compensation in upgrade eligibility.", status: "PUBLISHED", jobType: "FULL_TIME", locations: ["Remote"], applyBy: new Date("2099-12-31T00:00:00.000Z"), openings: 1, eligibleBranches: ["ECE"], ctcMax: 2_000_000, allowPlaced: true } });
    const historicalEligibility = await app!.inject({ method: "GET", url: `/v1/placements/drives/${reconciliationDrive.id}/eligibility/${importedStudentProfile.id}`, headers: universityHeaders });
    expect(historicalEligibility.statusCode).toBe(200);
    expect(historicalEligibility.json<{ eligibility: { eligible: boolean; reasons: string[] } }>().eligibility.reasons).toContain("Drive does not meet the placement upgrade threshold");
    const clearReconciliation = await app!.inject({ method: "PATCH", url: `/v1/placements/students/${importedStudentProfile.id}/reconciliation`, headers: universityHeaders, payload: { placed: false, currentCtc: null, currency: null, source: null } });
    expect(clearReconciliation.statusCode).toBe(200);

    await prisma.placementSeason.update({ where: { id: season.id }, data: { offerCap: 1 } });
    const capCompany = await prisma.placementCompany.create({ data: { organizationId, name: "Offer Cap Company" } });
    const studentUser = await prisma.user.create({ data: { email: createdStudentEmail, name: "Placement Student" } });
    const student = await prisma.studentProfile.create({ data: { userId: studentUser.id, organizationId, registrationNo: `IT-${Date.now()}`, branch: "CSE", graduationYear: 2099 } });
    const offerDrives = await Promise.all([1, 2].map((index) => prisma.placementDrive.create({ data: {
      seasonId: season.id, companyId: capCompany.id, title: `Offer Cap Role ${index}`, description: "A role for checking concurrent university offer cap enforcement.", status: "PUBLISHED", jobType: "FULL_TIME", locations: ["Remote"], applyBy: new Date("2099-12-31T00:00:00.000Z"), openings: 1, eligibleBranches: ["CSE"]
    } })));
    const offerApplications = await Promise.all(offerDrives.map((drive) => prisma.application.create({ data: { driveId: drive.id, studentId: student.id, status: "INTERVIEWING" } })));
    const concurrentOffers = await Promise.all(offerApplications.map((application) => app!.inject({ method: "POST", url: "/v1/placements/offers", headers: universityHeaders, payload: { applicationId: application.id, ctc: 1_000_000, currency: "INR" } })));
    expect(concurrentOffers.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(await prisma.offer.count({ where: { application: { studentId: student.id, drive: { seasonId: season.id } } } })).toBe(1);
    expect(await prisma.userNotification.count({ where: { userId: studentUser.id, organizationId, type: "placement.offer.created" } })).toBe(1);
    const remainingApplication = await prisma.application.findFirstOrThrow({ where: { studentId: student.id, offer: null } });
    const terminalDecisions = await Promise.all(["REJECTED", "WITHDRAWN"].map((status) => app!.inject({ method: "PATCH", url: `/v1/placements/applications/${remainingApplication.id}`, headers: universityHeaders, payload: { status } })));
    expect(terminalDecisions.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(await prisma.auditEvent.count({ where: { organizationId, entityId: remainingApplication.id, action: "placement.application.status.changed" } })).toBe(1);
    expect(await prisma.userNotification.count({ where: { organizationId, type: "placement.application.updated", data: { path: ["applicationId"], equals: remainingApplication.id } } })).toBe(1);
    const codingCandidate = await prisma.candidate.create({ data: { organizationId, name: "Coding Guard Candidate", email: `coding-guard-${Date.now()}@example.test` } });
    const codingJob = await prisma.job.create({ data: { organizationId, title: "Coding Guard Role", description: "A role used to verify that coding assessments remain disabled without isolation." } });
    const codingRound = await prisma.round.create({ data: { jobId: codingJob.id, title: "Sandbox Required", type: "CODING_TEST", sequence: 1 } });
    const codingInvite = await app!.inject({ method: "POST", url: "/v1/assessments", headers: { ...universityHeaders, "idempotency-key": `coding-guard-${Date.now()}` }, payload: { candidateId: codingCandidate.id, roundId: codingRound.id } });
    expect(codingInvite.statusCode).toBe(503);
    expect(codingInvite.json().error.code).toBe("code_sandbox_unavailable");
    const unusedRound = await prisma.round.create({ data: { jobId: codingJob.id, title: "Unused draft", type: "HUMAN_INTERVIEW", sequence: 2 } });
    const roundUrl = `/v1/jobs/${codingJob.id}/rounds/${unusedRound.id}`;
    const wrongJobRound = await app!.inject({ method: "DELETE", url: `/v1/jobs/not-this-job/rounds/${unusedRound.id}`, headers: universityHeaders });
    expect(wrongJobRound.statusCode).toBe(404);
    expect(await prisma.round.count({ where: { id: unusedRound.id } })).toBe(1);
    const removedRound = await app!.inject({ method: "DELETE", url: roundUrl, headers: universityHeaders });
    expect(removedRound.statusCode).toBe(204);
    expect(await prisma.round.count({ where: { id: unusedRound.id } })).toBe(0);
    expect(await prisma.auditEvent.count({ where: { organizationId, action: "job.round.deleted", entityId: unusedRound.id } })).toBe(1);
    const repeatedRemoval = await app!.inject({ method: "DELETE", url: roundUrl, headers: universityHeaders });
    expect(repeatedRemoval.statusCode).toBe(404);
    const historicalAssessment = await prisma.assessment.create({ data: { candidateId: codingCandidate.id, roundId: codingRound.id, status: "COMPLETED" } });
    const historyRemoval = await app!.inject({ method: "DELETE", url: `/v1/jobs/${codingJob.id}/rounds/${codingRound.id}`, headers: universityHeaders });
    expect(historyRemoval.statusCode).toBe(409);
    expect(historyRemoval.json().error.code).toBe("round_in_use");
    expect(await prisma.assessment.count({ where: { id: historicalAssessment.id } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { organizationId, action: "job.round.deleted", entityId: codingRound.id } })).toBe(0);
    for (let raceIndex = 0; raceIndex < 4; raceIndex++) {
      const raceRound = await prisma.round.create({ data: { jobId: codingJob.id, title: "Invitation removal race", type: "HUMAN_INTERVIEW", sequence: raceIndex + 3 } });
      const [invitation, removal] = await Promise.allSettled([
        prisma.assessment.create({ data: { candidateId: codingCandidate.id, roundId: raceRound.id } }),
        app!.inject({ method: "DELETE", url: `/v1/jobs/${codingJob.id}/rounds/${raceRound.id}`, headers: universityHeaders })
      ]);
      expect(removal.status).toBe("fulfilled");
      if (removal.status !== "fulfilled") throw removal.reason;
      if (invitation.status === "fulfilled") {
        expect(removal.value.statusCode).toBe(409);
        expect(await prisma.assessment.count({ where: { id: invitation.value.id } })).toBe(1);
        expect(await prisma.round.count({ where: { id: raceRound.id } })).toBe(1);
      } else {
        expect(removal.value.statusCode).toBe(204);
        expect(await prisma.assessment.count({ where: { roundId: raceRound.id } })).toBe(0);
        expect(await prisma.round.count({ where: { id: raceRound.id } })).toBe(0);
      }
    }
    const foreignRound = await prisma.round.findFirst({ where: { job: { organizationId: { not: organizationId } } }, select: { id: true, jobId: true } });
    expect(foreignRound).not.toBeNull();
    const foreignRemoval = await app!.inject({ method: "DELETE", url: `/v1/jobs/${foreignRound!.jobId}/rounds/${foreignRound!.id}`, headers: universityHeaders });
    expect(foreignRemoval.statusCode).toBe(404);
    expect(await prisma.round.count({ where: { id: foreignRound!.id } })).toBe(1);
    const retirementRound = await prisma.round.create({ data: { jobId: codingJob.id, title: "Retirement verification", type: "HUMAN_INTERVIEW", sequence: 10 } });
    const retirementUrl = `/v1/jobs/${codingJob.id}/rounds/${retirementRound.id}/retirement`;
    await prisma.organization.update({ where: { id: organizationId }, data: { creditBalance: 1000 } });
    const inviteRound = (key: string) => app!.inject({ method: "POST", url: "/v1/assessments", headers: { ...universityHeaders, "idempotency-key": key }, payload: { candidateId: codingCandidate.id, roundId: retirementRound.id } });
    const activeInvite = await inviteRound(`retirement-active-${Date.now()}`);
    expect(activeInvite.statusCode).toBe(201);
    const activeToken = new URL(activeInvite.json().launchUrl).pathname.split("/").at(-1)!;
    const retirement = await app!.inject({ method: "PATCH", url: retirementUrl, headers: universityHeaders, payload: { retired: true, expectedRetired: false } });
    expect(retirement.statusCode).toBe(200);
    expect(retirement.json().retiredAt).toBeTruthy();
    const balanceBeforeBlocked = (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).creditBalance;
    const blocked = await inviteRound(`retirement-blocked-${Date.now()}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe("assessment_round_retired");
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).creditBalance).toBe(balanceBeforeBlocked);
    expect(await prisma.assessment.count({ where: { roundId: retirementRound.id } })).toBe(1);
    expect((await app!.inject({ method: "GET", url: `/candidate/assessments/${activeToken}` })).statusCode).toBe(200);
    expect((await app!.inject({ method: "POST", url: `/candidate/assessments/${activeToken}/consent` })).statusCode).toBe(200);
    expect((await app!.inject({ method: "POST", url: `/candidate/assessments/${activeToken}/start` })).statusCode).toBe(200);
    expect((await app!.inject({ method: "GET", url: `/v1/assessments/${activeInvite.json().assessment.id}`, headers: universityHeaders })).statusCode).toBe(200);
    const noOpRetirement = await app!.inject({ method: "PATCH", url: retirementUrl, headers: universityHeaders, payload: { retired: true, expectedRetired: true } });
    expect(noOpRetirement.statusCode).toBe(200);
    expect(await prisma.auditEvent.count({ where: { entityId: retirementRound.id, action: "job.round.retired" } })).toBe(1);
    const staleRestoration = await app!.inject({ method: "PATCH", url: retirementUrl, headers: universityHeaders, payload: { retired: false, expectedRetired: false } });
    expect(staleRestoration.statusCode).toBe(409);
    expect((await app!.inject({ method: "PATCH", url: `/v1/jobs/${foreignRound!.jobId}/rounds/${foreignRound!.id}/retirement`, headers: universityHeaders, payload: { retired: true, expectedRetired: false } })).statusCode).toBe(404);
    const restore = await app!.inject({ method: "PATCH", url: retirementUrl, headers: universityHeaders, payload: { retired: false, expectedRetired: true } });
    expect(restore.statusCode).toBe(200);
    expect(restore.json().retiredAt).toBeNull();
    const beforeRace = await prisma.assessment.count({ where: { roundId: retirementRound.id } });
    const [racedInvite, racedRetirement] = await Promise.all([
      inviteRound(`retirement-race-${Date.now()}`),
      app!.inject({ method: "PATCH", url: retirementUrl, headers: universityHeaders, payload: { retired: true, expectedRetired: false } })
    ]);
    expect(racedRetirement.statusCode).toBe(200);
    expect([201, 409]).toContain(racedInvite.statusCode);
    expect(await prisma.assessment.count({ where: { roundId: retirementRound.id } })).toBe(beforeRace + (racedInvite.statusCode === 201 ? 1 : 0));
    expect((await inviteRound(`retirement-after-race-${Date.now()}`)).statusCode).toBe(409);
    const retryRound = await prisma.round.create({ data: { jobId: codingJob.id, title: "Invitation idempotency", type: "HUMAN_INTERVIEW", sequence: 11 } });
    const costlyRound = await prisma.round.create({ data: { jobId: codingJob.id, title: "Credit serialization", type: "AI_INTERVIEW", sequence: 12 } });
    await prisma.organization.update({ where: { id: organizationId }, data: { creditBalance: 10 } });
    const retryKey = `invitation-retry-${Date.now()}`;
    const requestInvite = (key: string, roundId = retryRound.id, expiresInHours = 72) => app!.inject({ method: "POST", url: "/v1/assessments", headers: { ...universityHeaders, "idempotency-key": key }, payload: { candidateId: codingCandidate.id, roundId, expiresInHours } });
    const retryResults = await Promise.all([requestInvite(retryKey), requestInvite(retryKey)]);
    expect(retryResults.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    expect(retryResults[0]!.json().assessment.id).toBe(retryResults[1]!.json().assessment.id);
    const replayResponse = retryResults.find((response) => response.statusCode === 200)!;
    expect(replayResponse.headers["idempotent-replay"]).toBe("true");
    expect(replayResponse.json()).toMatchObject({ launchUrl: null, replayed: true });
    expect(await prisma.creditLedger.count({ where: { organizationId, idempotencyKey: retryKey } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { organizationId, entityId: replayResponse.json().assessment.id, action: "assessment.created" } })).toBe(1);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).creditBalance).toBe(8);
    expect((await requestInvite(retryKey, costlyRound.id)).statusCode).toBe(409);
    const changedExpiry = await requestInvite(retryKey, retryRound.id, 24);
    expect(changedExpiry.statusCode).toBe(409);
    expect(changedExpiry.json().error.code).toBe("idempotency_key_conflict");
    const parallelDistinct = await Promise.all([requestInvite(`distinct-human-${Date.now()}`), requestInvite(`distinct-ai-${Date.now()}`, costlyRound.id)]);
    expect(parallelDistinct.map((response) => response.statusCode)).toEqual([201, 201]);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).creditBalance).toBe(1);
    const beforeInsufficient = await prisma.assessment.count({ where: { candidateId: codingCandidate.id } });
    const insufficientKey = `insufficient-${Date.now()}`;
    const insufficient = await requestInvite(insufficientKey, costlyRound.id);
    expect(insufficient.statusCode).toBe(409);
    expect(insufficient.json().error.code).toBe("insufficient_credits");
    expect(await prisma.assessment.count({ where: { candidateId: codingCandidate.id } })).toBe(beforeInsufficient);
    expect(await prisma.creditLedger.count({ where: { organizationId, idempotencyKey: insufficientKey } })).toBe(0);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).creditBalance).toBe(1);
    const otherPurposeKey = `other-purpose-${Date.now()}`;
    await prisma.creditLedger.create({ data: { organizationId, idempotencyKey: otherPurposeKey, amount: 0, balanceAfter: 1, reason: "Fictional collision fixture", referenceType: "grant" } });
    expect((await requestInvite(otherPurposeKey)).json().error.code).toBe("idempotency_key_conflict");
    const frozenAssessment = retryResults.find((response) => response.statusCode === 201)!.json();
    const frozenToken = new URL(frozenAssessment.launchUrl).pathname.split("/").at(-1)!;
    expect(frozenAssessment.assessment.configuration).toMatchObject({ version: 1, round: { title: "Invitation idempotency", type: "HUMAN_INTERVIEW" } });
    const roleEdit = await app!.inject({ method: "PATCH", url: `/v1/jobs/${codingJob.id}`, headers: universityHeaders, payload: {
      title: "Edited after invitation", requirements: [{ name: "New requirement after invitation", weight: 100 }],
      rounds: [{ sequence: 11, title: "Edited after invitation", type: "CODING_TEST", durationMinutes: 55, questions: [{ id: "changed", label: "A changed question after invitation" }] }]
    } });
    expect(roleEdit.statusCode).toBe(200);
    const frozenLaunch = await app!.inject({ method: "GET", url: `/candidate/assessments/${frozenToken}` });
    expect(frozenLaunch.statusCode).toBe(200);
    expect(frozenLaunch.json().assessment).toMatchObject({ type: "HUMAN_INTERVIEW", roundTitle: "Invitation idempotency", jobTitle: "Coding Guard Role", durationMinutes: 20 });
    expect(frozenLaunch.json().assessment.questions).toHaveLength(3);
    const frozenReport = await app!.inject({ method: "GET", url: `/v1/assessments/${frozenAssessment.assessment.id}`, headers: universityHeaders });
    expect(frozenReport.statusCode).toBe(200);
    expect(frozenReport.json()).toMatchObject({ configurationSource: "invitation_snapshot", assessment: { round: { title: "Invitation idempotency", type: "HUMAN_INTERVIEW", job: { title: "Coding Guard Role", requirements: [] } } } });
    expect((await prisma.assessment.findUniqueOrThrow({ where: { id: frozenAssessment.assessment.id } })).configuration).toEqual(frozenAssessment.assessment.configuration);
    const clientResponse = await app!.inject({ method: "POST", url: "/v1/clients", headers: universityHeaders, payload: { name: "Placement Fee Client", status: "ACTIVE", feeType: "PERCENTAGE", feeAmount: 15, currency: "USD", guaranteeDays: 90 } });
    expect(clientResponse.statusCode).toBe(201);
    const staffingClient = clientResponse.json<{ id: string }>();
    const staffingCandidate = await prisma.candidate.create({ data: { organizationId, name: "Placed Candidate", email: `placed-candidate-${Date.now()}@example.test` } });
    const staffingJob = await prisma.job.create({ data: { organizationId, clientId: staffingClient.id, title: "Placement Fee Role", description: "A role connected to client fee terms for the staffing placement workflow." } });
    const candidateJob = await prisma.candidateJob.create({ data: { candidateId: staffingCandidate.id, jobId: staffingJob.id } });
    const stageCreations = await Promise.all(["Intake", "Review", "Decision"].map((name) => app!.inject({ method: "POST", url: "/v1/pipeline/stages", headers: universityHeaders, payload: { name } })));
    expect(stageCreations.map((response) => response.statusCode)).toEqual([201, 201, 201]);
    const stageList = await app!.inject({ method: "GET", url: "/v1/pipeline/stages", headers: universityHeaders });
    const originalStages = stageList.json<{ data: Array<{ id: string; sortOrder: number }> }>().data;
    const originalOrder = originalStages.map((stage) => stage.id);
    expect(originalStages.map((stage) => stage.sortOrder)).toEqual(originalStages.map((_, index) => index));
    await prisma.candidateJob.update({ where: { id: candidateJob.id }, data: { stageId: originalOrder[0]! } });
    const reversedOrder = [...originalOrder].reverse();
    const orderPayload = { stageIds: reversedOrder, expectedStageIds: originalOrder };
    const reordered = await app!.inject({ method: "PATCH", url: "/v1/pipeline/stages/order", headers: universityHeaders, payload: orderPayload });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json<{ data: Array<{ id: string }> }>().data.map((stage) => stage.id)).toEqual(reversedOrder);
    const staleReorder = await app!.inject({ method: "PATCH", url: "/v1/pipeline/stages/order", headers: universityHeaders, payload: orderPayload });
    expect(staleReorder.statusCode).toBe(409);
    expect(staleReorder.json().error.code).toBe("pipeline_order_changed");
    for (const invalidIds of [[...reversedOrder, reversedOrder[0]], reversedOrder.slice(1), [...reversedOrder.slice(1), "foreign-stage"]]) {
      const invalidOrder = await app!.inject({ method: "PATCH", url: "/v1/pipeline/stages/order", headers: universityHeaders, payload: { stageIds: invalidIds, expectedStageIds: reversedOrder } });
      expect(invalidOrder.statusCode).toBe(422);
    }
    const studentReorder = await app!.inject({ method: "PATCH", url: "/v1/pipeline/stages/order", headers: studentHeaders, payload: { stageIds: originalOrder, expectedStageIds: reversedOrder } });
    expect(studentReorder.statusCode).toBe(403);
    const competingOrders = [originalOrder, [...reversedOrder.slice(1), reversedOrder[0]!]];
    const competingReorders = await Promise.all(competingOrders.map((stageIds) => app!.inject({ method: "PATCH", url: "/v1/pipeline/stages/order", headers: universityHeaders, payload: { stageIds, expectedStageIds: reversedOrder } })));
    expect(competingReorders.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const winningOrder = competingOrders[competingReorders.findIndex((response) => response.statusCode === 200)]!;
    const storedStages = await prisma.pipelineStage.findMany({ where: { organizationId }, orderBy: { sortOrder: "asc" } });
    expect(storedStages.map((stage) => stage.id)).toEqual(winningOrder);
    expect(storedStages.map((stage) => stage.sortOrder)).toEqual(storedStages.map((_, index) => index));
    expect((await prisma.candidateJob.findUniqueOrThrow({ where: { id: candidateJob.id } })).stageId).toBe(originalOrder[0]);
    expect(await prisma.auditEvent.count({ where: { organizationId, action: "pipeline.stages.reordered" } })).toBe(2);
    const usedStageRemoval = await app!.inject({ method: "DELETE", url: `/v1/pipeline/stages/${originalOrder[0]}`, headers: universityHeaders });
    expect(usedStageRemoval.statusCode).toBe(409);
    expect(usedStageRemoval.json().error.code).toBe("pipeline_stage_in_use");
    const unusedStageRemovals = await Promise.all(originalOrder.slice(1).map((id) => app!.inject({ method: "DELETE", url: `/v1/pipeline/stages/${id}`, headers: universityHeaders })));
    expect(unusedStageRemovals.every((response) => response.statusCode === 204)).toBe(true);
    await prisma.candidateJob.update({ where: { id: candidateJob.id }, data: { stageId: null } });
    const lastStageRemoval = await app!.inject({ method: "DELETE", url: `/v1/pipeline/stages/${originalOrder[0]}`, headers: universityHeaders });
    expect(lastStageRemoval.statusCode).toBe(409);
    expect(lastStageRemoval.json().error.code).toBe("last_pipeline_stage");
    const placementResponse = await app!.inject({ method: "POST", url: "/v1/staffing/placements", headers: universityHeaders, payload: { candidateJobId: candidateJob.id, startDate: "2026-10-01T00:00:00.000Z", salary: 120_000, salaryCurrency: "USD" } });
    expect(placementResponse.statusCode).toBe(201);
    const placement = placementResponse.json<{ id: string; feeAmount: string; guaranteeUntil: string; invoice: { id: string; status: string; amount: string } }>();
    expect(Number(placement.feeAmount)).toBe(18_000);
    expect(Number(placement.invoice.amount)).toBe(18_000);
    expect(placement.invoice.status).toBe("DRAFT");
    const duplicatePlacement = await app!.inject({ method: "POST", url: "/v1/staffing/placements", headers: universityHeaders, payload: { candidateJobId: candidateJob.id, startDate: "2026-10-01T00:00:00.000Z", salary: 120_000, salaryCurrency: "USD" } });
    expect(duplicatePlacement.statusCode).toBe(409);
    const issueInvoice = await app!.inject({ method: "PATCH", url: `/v1/staffing/invoices/${placement.invoice.id}`, headers: universityHeaders, payload: { status: "ISSUED", dueAt: "2026-11-01T00:00:00.000Z" } });
    expect(issueInvoice.statusCode).toBe(200);
    const paidInvoice = await app!.inject({ method: "PATCH", url: `/v1/staffing/invoices/${placement.invoice.id}`, headers: universityHeaders, payload: { status: "PAID" } });
    expect(paidInvoice.statusCode).toBe(200);
    expect(paidInvoice.json()).toMatchObject({ status: "PAID" });
    const resolveGuarantee = await app!.inject({ method: "PATCH", url: `/v1/staffing/placements/${placement.id}/guarantee`, headers: universityHeaders, payload: { resolved: true } });
    expect(resolveGuarantee.statusCode).toBe(200);
    const apiKeyResponse = await app!.inject({ method: "POST", url: "/v1/api-keys", headers: { cookie, "x-organization-id": organizationId }, payload: { name: "integration candidates", environment: "test", scopes: ["candidates:write"] } });
    expect(apiKeyResponse.statusCode).toBe(201);
    const apiKey = apiKeyResponse.json<{ id: string; secret: string }>();
    const apiCandidate = await app!.inject({ method: "POST", url: "/public/v1/candidates", headers: { authorization: `Bearer ${apiKey.secret}` }, payload: { name: "API Key Candidate", email: `api-${Date.now()}@example.test` } });
    expect(apiCandidate.statusCode).toBe(201);
    const outOfScope = await app!.inject({ method: "GET", url: "/public/v1/jobs", headers: { authorization: `Bearer ${apiKey.secret}` } });
    expect(outOfScope.statusCode).toBe(403);
    const endpoints = await Promise.all([0, 1].map((index) => prisma.webhookEndpoint.create({ data: { organizationId, url: `https://subscriber-${index}.example.test`, events: ["candidate.created", "candidate.updated", "candidate_job.created", "candidate_job.stage_changed", "meeting.created", "assessment.completed", "placement.application.created"], secretHash: `test-secret-${index}`, secretEncrypted: encryptWebhookSecret(`test-webhook-secret-${index}`) } })));
    const inactiveEndpoint = await prisma.webhookEndpoint.create({ data: { organizationId, url: "https://disabled.example.test", events: ["candidate.created", "candidate.updated"], active: false, secretHash: "inactive-test-secret", secretEncrypted: encryptWebhookSecret("inactive-test-secret") } });
    const queueOutage = vi.spyOn(Queue.prototype, "add").mockRejectedValue(new Error("Simulated Redis outage"));
    try {
      const webhookEmail = `webhook-api-${Date.now()}@example.test`;
      const writeHeaders = { authorization: `Bearer ${apiKey.secret}` };
      const firstWrite = await app!.inject({ method: "POST", url: "/public/v1/candidates", headers: writeHeaders, payload: { name: "Webhook Candidate", email: webhookEmail } });
      expect(firstWrite.statusCode).toBe(201);
      const webhookCandidate = firstWrite.json<{ id: string }>();
      const createdDeliveries = await prisma.webhookDelivery.findMany({ where: { endpointId: { in: endpoints.map((endpoint) => endpoint.id) }, eventType: "candidate.created" } });
      expect(createdDeliveries).toHaveLength(2);
      expect(new Set(createdDeliveries.map((delivery) => delivery.eventId)).size).toBe(1);
      for (const delivery of createdDeliveries) {
        expect(delivery.status).toBe("PENDING");
        expect(delivery.attemptCount).toBe(0);
        expect(delivery.payload).toMatchObject({ id: delivery.eventId, type: "candidate.created", version: 1, data: { candidate_id: webhookCandidate.id, source: "API" } });
        expect(JSON.stringify(delivery.payload)).not.toContain(webhookEmail);
        expect(JSON.stringify(delivery.payload)).not.toContain(apiKey.secret);
      }
      const noOp = await app!.inject({ method: "POST", url: "/public/v1/candidates", headers: writeHeaders, payload: { name: "Webhook Candidate", email: webhookEmail } });
      expect(noOp.statusCode).toBe(200);
      expect(await prisma.webhookDelivery.count({ where: { endpointId: { in: endpoints.map((endpoint) => endpoint.id) } } })).toBe(2);
      const changed = await app!.inject({ method: "POST", url: "/public/v1/candidates", headers: writeHeaders, payload: { name: "Updated Candidate", email: webhookEmail, headline: "Updated evidence" } });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().id).toBe(webhookCandidate.id);
      const updatedDeliveries = await prisma.webhookDelivery.findMany({ where: { endpointId: { in: endpoints.map((endpoint) => endpoint.id) }, eventType: "candidate.updated" } });
      expect(updatedDeliveries).toHaveLength(2);
      expect(updatedDeliveries.every((delivery) => delivery.status === "PENDING")).toBe(true);
      expect(updatedDeliveries[0]!.payload).toMatchObject({ version: 1, type: "candidate.updated", data: { candidate_id: webhookCandidate.id, changed_fields: ["name", "headline"] } });
      const candidateAudits = await prisma.auditEvent.findMany({ where: { entityId: webhookCandidate.id, action: "candidate.upserted.via_api_key" } });
      expect(candidateAudits).toHaveLength(3);
      expect(candidateAudits.every((audit) => typeof audit.metadata === "object" && audit.metadata !== null && "apiKeyId" in audit.metadata && audit.metadata.apiKeyId === apiKey.id)).toBe(true);
      const racedEmail = `webhook-race-${Date.now()}@example.test`;
      const racedWrites = await Promise.all([0, 1].map(() => app!.inject({ method: "POST", url: "/public/v1/candidates", headers: writeHeaders, payload: { name: "Concurrent Candidate", email: racedEmail } })));
      expect(racedWrites.map((response) => response.statusCode).sort()).toEqual([200, 201]);
      expect(racedWrites[0]!.json().id).toBe(racedWrites[1]!.json().id);
      expect(await prisma.webhookDelivery.count({ where: { endpointId: { in: endpoints.map((endpoint) => endpoint.id) }, eventType: "candidate.created" } })).toBe(4);
      const rollbackEmail = `webhook-rollback-${Date.now()}@example.test`;
      const beforeRollback = await prisma.webhookDelivery.count({ where: { endpointId: { in: endpoints.map((endpoint) => endpoint.id) } } });
      await expect(prisma.$transaction(async (tx) => {
        const candidate = await tx.candidate.create({ data: { organizationId, name: "Rolled back", email: rollbackEmail } });
        await tx.auditEvent.create({ data: { organizationId, action: "test.webhook.rollback", entityType: "candidate", entityId: candidate.id } });
        await persistWebhookEvent(tx, organizationId, "candidate.created", { candidate_id: candidate.id });
        throw new Error("Rollback verification");
      })).rejects.toThrow("Rollback verification");
      expect(await prisma.candidate.count({ where: { organizationId, email: rollbackEmail } })).toBe(0);
      expect(await prisma.auditEvent.count({ where: { organizationId, action: "test.webhook.rollback" } })).toBe(0);
      expect(await prisma.webhookDelivery.count({ where: { endpointId: { in: endpoints.map((endpoint) => endpoint.id) } } })).toBe(beforeRollback);
      const workspaceCandidate = await app!.inject({ method: "POST", url: "/v1/candidates", headers: universityHeaders, payload: { name: "Workspace Webhook Candidate", email: `workspace-webhook-${Date.now()}@example.test` } });
      expect(workspaceCandidate.statusCode).toBe(201);
      expect(await prisma.webhookDelivery.count({ where: { endpointId: { in: endpoints.map((endpoint) => endpoint.id) }, eventType: "candidate.created" } })).toBe(6);
      expect(await prisma.webhookDelivery.count({ where: { endpointId: inactiveEndpoint.id } })).toBe(0);
      const eventEndpoints = { in: endpoints.map((endpoint) => endpoint.id) };
      const outboxJob = await prisma.job.create({ data: { organizationId, title: "Outbox Role", description: "A fictional role for atomic workflow event verification.", requirements: { create: { name: "Reliability", weight: 100 } } } });
      const assignmentResponse = await app!.inject({ method: "POST", url: "/v1/candidate-jobs", headers: universityHeaders, payload: { candidateId: webhookCandidate.id, jobId: outboxJob.id } });
      expect(assignmentResponse.statusCode).toBe(201);
      const assignment = assignmentResponse.json<{ id: string; stage: { id: string } }>();
      expect(await prisma.webhookDelivery.count({ where: { endpointId: eventEndpoints, eventType: "candidate_job.created" } })).toBe(2);
      const targetStageResponse = await app!.inject({ method: "POST", url: "/v1/pipeline/stages", headers: universityHeaders, payload: { name: "Outbox target" } });
      expect(targetStageResponse.statusCode).toBe(201);
      const targetStage = targetStageResponse.json<{ id: string }>();
      const stageMoves = await Promise.all([0, 1].map(() => app!.inject({ method: "PATCH", url: `/v1/candidate-jobs/${assignment.id}/stage`, headers: universityHeaders, payload: { stageId: targetStage.id } })));
      expect(stageMoves.every((response) => response.statusCode === 200)).toBe(true);
      const moveDeliveries = await prisma.webhookDelivery.findMany({ where: { endpointId: eventEndpoints, eventType: "candidate_job.stage_changed" } });
      expect(moveDeliveries).toHaveLength(2);
      expect(moveDeliveries[0]!.payload).toMatchObject({ data: { from_stage_id: assignment.stage.id, to_stage_id: targetStage.id } });
      expect(await prisma.auditEvent.count({ where: { organizationId, action: "pipeline.stage.changed", entityId: assignment.id } })).toBe(1);
      const meetingResponse = await app!.inject({ method: "POST", url: "/v1/meetings", headers: universityHeaders, payload: { title: "Outbox meeting", startsAt: "2099-01-01T12:00:00.000Z", candidateId: webhookCandidate.id } });
      expect(meetingResponse.statusCode).toBe(201);
      expect(await prisma.webhookDelivery.count({ where: { endpointId: eventEndpoints, eventType: "meeting.created" } })).toBe(2);
      const evaluationRound = await prisma.round.create({ data: { jobId: outboxJob.id, title: "Atomic completion", type: "AI_INTERVIEW", sequence: 1 } });
      const concurrentAssessment = await prisma.assessment.create({ data: { candidateId: webhookCandidate.id, roundId: evaluationRound.id, status: "PROCESSING" } });
      const result = { overallScore: 70, summary: "Advisory verification result", evidence: [{ name: "Reliability", score: 70, weight: 100, rationale: "Fictional test evidence", evidence: "Fictional response" }] };
      const completions = await Promise.all([0, 1].map(() => prisma.$transaction((tx) => completeAssessment(tx, concurrentAssessment.id, result))));
      expect(completions.map((completion) => completion.replayed).sort()).toEqual([false, true]);
      expect(await prisma.scoreEvidence.count({ where: { assessmentId: concurrentAssessment.id } })).toBe(1);
      expect(await prisma.auditEvent.count({ where: { organizationId, action: "assessment.completed", entityId: concurrentAssessment.id } })).toBe(1);
      expect(await prisma.webhookDelivery.count({ where: { endpointId: eventEndpoints, eventType: "assessment.completed" } })).toBe(2);
      const rolledBackAssessment = await prisma.assessment.create({ data: { candidateId: webhookCandidate.id, roundId: evaluationRound.id, status: "PROCESSING" } });
      await expect(prisma.$transaction(async (tx) => { await completeAssessment(tx, rolledBackAssessment.id, result); throw new Error("Completion rollback"); })).rejects.toThrow("Completion rollback");
      expect((await prisma.assessment.findUniqueOrThrow({ where: { id: rolledBackAssessment.id } })).status).toBe("PROCESSING");
      expect(await prisma.scoreEvidence.count({ where: { assessmentId: rolledBackAssessment.id } })).toBe(0);
      expect(await prisma.auditEvent.count({ where: { entityId: rolledBackAssessment.id } })).toBe(0);
      expect(await prisma.webhookDelivery.count({ where: { endpointId: eventEndpoints, eventType: "assessment.completed" } })).toBe(2);
      const submissionToken = `outbox-submission-${Date.now()}`;
      const inlineAssessment = await prisma.assessment.create({ data: { candidateId: webhookCandidate.id, roundId: evaluationRound.id, status: "IN_PROGRESS", launchTokenHash: createHash("sha256").update(submissionToken).digest("hex"), launchExpiresAt: new Date("2099-01-01"), consentedAt: new Date(), startedAt: new Date() } });
      vi.stubEnv("ASSESSMENT_PROCESSING_MODE", "inline");
      try {
        const submissions = await Promise.all([0, 1].map(() => app!.inject({ method: "POST", url: `/candidate/assessments/${submissionToken}/submit`, payload: { response: "I demonstrated reliability through monitored retries and reviewable rollback evidence." } })));
        expect(submissions.map((response) => response.statusCode).sort()).toEqual([200, 409]);
        expect(await prisma.scoreEvidence.count({ where: { assessmentId: inlineAssessment.id } })).toBe(1);
        expect(await prisma.webhookDelivery.count({ where: { endpointId: eventEndpoints, eventType: "assessment.completed" } })).toBe(4);
      } finally { vi.unstubAllEnvs(); }
      await prisma.placementSeason.update({ where: { id: season.id }, data: { offerCap: 20, upgradeMultiple: null } });
      for (const selfService of [true, false]) {
        const drive = await prisma.placementDrive.create({ data: { seasonId: season.id, companyId: responseCompany.id, title: `Outbox ${selfService ? "student" : "staff"} drive`, description: "Fictional application event verification", status: "PUBLISHED", jobType: "FULL_TIME", locations: ["Remote"], applyBy: new Date("2099-01-01"), openings: 1, eligibleBranches: [], allowPlaced: true } });
        const applicationResponse = await app!.inject({ method: "POST", url: selfService ? "/v1/student/applications" : "/v1/placements/applications", headers: selfService ? studentHeaders : universityHeaders, payload: { driveId: drive.id, ...(selfService ? {} : { studentId: student.id }) } });
        expect(applicationResponse.statusCode).toBe(201);
      }
      expect(await prisma.webhookDelivery.count({ where: { endpointId: eventEndpoints, eventType: "placement.application.created" } })).toBe(4);
      const replayDelivery = createdDeliveries[0]!;
      await prisma.webhookDelivery.update({ where: { id: replayDelivery.id }, data: { status: "FAILED", attemptCount: 6 } });
      const replays = await Promise.all([0, 1].map(() => app!.inject({ method: "POST", url: `/v1/webhooks/deliveries/${replayDelivery.id}/replay`, headers: universityHeaders, payload: {} })));
      expect(replays.map((response) => response.statusCode).sort()).toEqual([202, 409]);
      expect(await prisma.auditEvent.count({ where: { organizationId, action: "webhook.delivery.replayed", entityId: replayDelivery.id } })).toBe(1);
      expect(await prisma.webhookDelivery.findUnique({ where: { id: replayDelivery.id } })).toMatchObject({ status: "PENDING", attemptCount: 0 });
      expect(queueOutage).toHaveBeenCalled();
    } finally {
      queueOutage.mockRestore();
      await prisma.webhookEndpoint.updateMany({ where: { id: { in: endpoints.map((endpoint) => endpoint.id) } }, data: { active: false } });
    }
    const readKeyResponse = await app!.inject({ method: "POST", url: "/v1/api-keys", headers: universityHeaders, payload: { name: "pagination integration", environment: "test", scopes: ["jobs:read", "candidates:read"] } });
    expect(readKeyResponse.statusCode).toBe(201);
    const readKey = readKeyResponse.json<{ id: string; secret: string }>();
    const readKeyHeaders = { authorization: `Bearer ${readKey.secret}` };
    const tiedTimestamp = new Date("2099-01-01T00:00:00.000Z");
    await Promise.all([
      prisma.candidate.createMany({ data: Array.from({ length: 105 }, (_, index) => ({ organizationId, name: `Pagination Candidate ${index}`, email: `pagination-${index}-${Date.now()}@example.test`, createdAt: tiedTimestamp })) }),
      prisma.job.createMany({ data: Array.from({ length: 105 }, (_, index) => ({ organizationId, title: `Pagination Job ${index}`, description: "Fictional pagination verification role.", status: "OPEN" as const, createdAt: tiedTimestamp })) })
    ]);
    const expectedCandidates = await prisma.candidate.findMany({ where: { organizationId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    const expectedJobs = await prisma.job.findMany({ where: { organizationId, status: "OPEN" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } });
    type PublicList = { data: Array<{ id: string }>; has_more: boolean; next_cursor: string | null; total_count: number };
    for (const [resource, expected] of [["candidates", expectedCandidates], ["jobs", expectedJobs]] as const) {
      const defaultPage = await app!.inject({ method: "GET", url: `/public/v1/${resource}`, headers: readKeyHeaders });
      expect(defaultPage.statusCode).toBe(200);
      expect(defaultPage.json<PublicList>()).toMatchObject({ has_more: true, total_count: expected.length });
      expect(defaultPage.json<PublicList>().data).toHaveLength(100);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
        const pageUrl: string = `/public/v1/${resource}?limit=17${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const response = await app!.inject({ method: "GET", url: pageUrl, headers: readKeyHeaders });
        expect(response.statusCode).toBe(200);
        const page: PublicList = response.json();
        expect(page.data.length).toBeLessThanOrEqual(17);
        expect(page.total_count).toBe(expected.length);
        seen.push(...page.data.map((row) => row.id));
        if (!page.has_more) { expect(page.next_cursor).toBeNull(); break; }
        expect(page.next_cursor).toBe(page.data.at(-1)!.id);
        cursor = page.next_cursor;
      }
      expect(seen).toEqual(expected.map((row) => row.id));
      expect(new Set(seen).size).toBe(seen.length);
      for (const limit of ["0", "101", "1.5", "nope"]) {
        expect((await app!.inject({ method: "GET", url: `/public/v1/${resource}?limit=${limit}`, headers: readKeyHeaders })).statusCode).toBe(422);
      }
    }
    const foreignCandidate = await prisma.candidate.findFirst({ where: { organizationId: { not: organizationId } }, select: { id: true } });
    expect(foreignCandidate).not.toBeNull();
    for (const cursor of [foreignCandidate!.id, "nonexistent-candidate", codingJob.id]) {
      const invalidCursor = await app!.inject({ method: "GET", url: `/public/v1/candidates?cursor=${encodeURIComponent(cursor)}`, headers: readKeyHeaders });
      expect(invalidCursor.statusCode).toBe(422);
      expect(invalidCursor.json().error.code).toBe("invalid_cursor");
    }
    for (const cursor of [foreignRound!.jobId, codingJob.id, "nonexistent-job"]) {
      const invalidCursor = await app!.inject({ method: "GET", url: `/public/v1/jobs?cursor=${encodeURIComponent(cursor)}`, headers: readKeyHeaders });
      expect(invalidCursor.statusCode).toBe(422);
      expect(invalidCursor.json().error.code).toBe("invalid_cursor");
    }
    await prisma.candidate.delete({ where: { id: expectedCandidates[0]!.id } });
    const deletedCursor = await app!.inject({ method: "GET", url: `/public/v1/candidates?cursor=${expectedCandidates[0]!.id}`, headers: readKeyHeaders });
    expect(deletedCursor.statusCode).toBe(422);
    expect(deletedCursor.json().error.code).toBe("invalid_cursor");
    const readOnlyWrite = await app!.inject({ method: "POST", url: "/public/v1/candidates", headers: readKeyHeaders, payload: { name: "Not permitted", email: "readonly@example.test" } });
    expect(readOnlyWrite.statusCode).toBe(403);
    expect((await app!.inject({ method: "DELETE", url: `/v1/api-keys/${readKey.id}`, headers: universityHeaders })).statusCode).toBe(204);
    expect((await app!.inject({ method: "GET", url: "/public/v1/candidates?limit=1", headers: readKeyHeaders })).statusCode).toBe(401);
    const revoke = await app!.inject({ method: "DELETE", url: `/v1/api-keys/${apiKey.id}`, headers: { cookie, "x-organization-id": organizationId } });
    expect(revoke.statusCode).toBe(204);
    const revokedRequest = await app!.inject({ method: "GET", url: "/public/v1/jobs", headers: { authorization: `Bearer ${apiKey.secret}` } });
    expect(revokedRequest.statusCode).toBe(401);
    const enrollment = await app!.inject({ method: "POST", url: "/v1/auth/mfa/enroll", headers: { cookie }, payload: {} });
    expect(enrollment.statusCode).toBe(200);
    const secret = enrollment.json<{ secret: string }>().secret;
    const confirmation = await app!.inject({ method: "POST", url: "/v1/auth/mfa/confirm", headers: { cookie }, payload: { code: currentTotpCode(secret) } });
    expect(confirmation.statusCode).toBe(200);
    const codes = confirmation.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(codes).toHaveLength(10);

    const challenge = await app!.inject({ method: "POST", url: "/v1/auth/login", payload: { email: createdEmail, password: "updated-integration-password" } });
    expect(challenge.statusCode).toBe(202);
    expect(challenge.json().mfaRequired).toBe(true);
    const mfaLogin = await app!.inject({ method: "POST", url: "/v1/auth/login", payload: { email: createdEmail, password: "updated-integration-password", mfaCode: currentTotpCode(secret) } });
    expect(mfaLogin.statusCode).toBe(200);
    const recoveryLogin = await app!.inject({ method: "POST", url: "/v1/auth/login", payload: { email: createdEmail, password: "updated-integration-password", mfaCode: codes[0] } });
    expect(recoveryLogin.statusCode).toBe(200);
    const replayedRecovery = await app!.inject({ method: "POST", url: "/v1/auth/login", payload: { email: createdEmail, password: "updated-integration-password", mfaCode: codes[0] } });
    expect(replayedRecovery.statusCode).toBe(401);
    const disabled = await app!.inject({ method: "POST", url: "/v1/auth/mfa/disable", headers: { cookie: sessionCookie(recoveryLogin) }, payload: { password: "updated-integration-password", code: currentTotpCode(secret) } });
    expect(disabled.statusCode).toBe(200);
  }, 30_000);
});
