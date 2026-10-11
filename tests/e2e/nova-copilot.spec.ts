import { expect, test } from "@playwright/test";

test("Nova accurately disables model execution when credentials are missing", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("northstar.organizationId", "fictional-nova-org"));
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/workspace") return route.fulfill({ json: { organization: { name: "Fictional workspace", type: "EMPLOYER", creditBalance: 100 }, membership: { role: "RECRUITER" } } });
    if (path.endsWith("/nova/status")) return route.fulfill({ json: { configured: false, model: null, reason: "Configure NOVA_PROVIDER, NOVA_BASE_URL, NOVA_MODEL and NOVA_API_KEY. No demo model is substituted." } });
    if (path.endsWith("/nova/options")) return route.fulfill({ json: { roles: [], assessments: [], nextCursor: null } });
    if (path.endsWith("/nova/runs")) return route.fulfill({ json: { runs: [] } });
    return route.fulfill({ json: { user: { name: "Fictional Recruiter" }, organizations: [{ id: "fictional-nova-org", name: "Fictional workspace", type: "EMPLOYER", role: "RECRUITER" }] } });
  });
  await page.goto("/workspace/copilot");
  await expect(page.getByRole("heading", { name: "Ask Nova", exact: true })).toBeVisible();
  await expect(page.getByText("Nova is unavailable", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
  await expect(page.getByText(/No demo model is substituted/)).toBeVisible();
});

test("Nova reviews cited evidence, requires exact approval and restores saved outcomes", async ({ page }, testInfo) => {
  let executed = false;
  let created = false;
  let approvals = 0;
  let followUps = 0;
  const roles = [{ id: "role", title: "Fictional role", rounds: [{ id: "next", title: "Follow-up", sequence: 2 }] }];
  const assessments = [{ id: "source", candidateId: "candidate", candidate: { name: "Fictional Candidate" }, round: { title: "Written", sequence: 1 } }];
  const proposal = () => ({ id: "proposal", status: executed ? "EXECUTED" : "PROPOSED", fingerprint: "a".repeat(64), totalCredits: 1, expiresAt: new Date(Date.now() + 600_000).toISOString(), actions: [{ candidateName: "Fictional Candidate", candidateEmail: "fictional@example.test", roundTitle: "Follow-up", jobTitle: "Fictional role", credits: 1, expiresInHours: 72 }], result: executed ? [{ candidateId: "candidate", assessmentId: "created-assessment", launchUrl: "http://localhost:3000/assess/fictional-launch" }] : null });
  const run = () => ({ id: "run", status: executed ? "COMPLETED" : "READY", message: "Review evidence and prepare the selected invitation.", errorCode: null, attempts: 1, modelSteps: 3, response: { message: "Evidence review complete. The proposal needs your approval.", summaries: [{ assessmentId: "source", reportPath: "/workspace/reports/source", observations: [{ text: "The response describes a monitored outcome against the original rubric.", evidenceIds: ["evidence-1"] }] }] }, proposals: [proposal()], calls: [{ id: "read", name: "read_assessment_report", status: "COMPLETED" }, { id: "prepare", name: "prepare_invitations", status: "COMPLETED" }] });
  await page.addInitScript(() => localStorage.setItem("northstar.organizationId", "fictional-nova-org"));
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/workspace") return route.fulfill({ json: { organization: { name: "Fictional workspace", type: "EMPLOYER", creditBalance: 100 }, membership: { role: "RECRUITER" } } });
    if (path.endsWith("/nova/status")) return route.fulfill({ json: { configured: true, model: "explicit-test-double", reason: null } });
    if (path.endsWith("/nova/options")) return route.fulfill({ json: { roles, assessments: new URL(request.url()).searchParams.has("jobId") ? assessments : [], nextCursor: null } });
    if (path.endsWith("/nova/runs") && request.method() === "POST") {
      if (request.postDataJSON().parentRunId) {
        expect(request.postDataJSON()).toEqual({ parentRunId: "run", message: "Explain the evidence in more detail.", selection: { jobId: "role", selectedAssessmentIds: ["source"] } });
        followUps++;
        return route.fulfill({ status: 202, json: { id: "followup", status: "PENDING" } });
      }
      expect(request.postDataJSON().selection).toEqual({ jobId: "role", selectedAssessmentIds: ["source"], nextRoundId: "next" });
      created = true;
      return route.fulfill({ status: 202, json: { id: "run", status: "PENDING" } });
    }
    if (path.endsWith("/nova/runs")) return route.fulfill({ json: { runs: created ? [{ id: "run", status: run().status, message: run().message }] : [] } });
    if (path.endsWith("/nova/runs/run")) return route.fulfill({ json: { ...run(), context: { jobId: "role", selectedAssessmentIds: ["source"], nextRoundId: "next" } } });
    if (path.endsWith("/nova/runs/followup")) return route.fulfill({ json: { ...run(), id: "followup", status: "READY", message: "Explain the evidence in more detail.", context: { jobId: "role", selectedAssessmentIds: ["source"] }, conversation: [{ message: run().message, response: { message: run().response.message } }], response: { message: "Fresh evidence was retrieved for this follow-up.", summaries: run().response.summaries }, proposals: [] } });
    if (path.endsWith("/nova/proposals/proposal/approve")) {
      expect(request.postDataJSON()).toEqual({ fingerprint: "a".repeat(64), confirm: true });
      approvals++;
      executed = true;
      return route.fulfill({ json: { proposal: proposal(), result: proposal().result } });
    }
    return route.fulfill({ json: { user: { name: "Fictional Recruiter" }, organizations: [{ id: "fictional-nova-org", name: "Fictional workspace", type: "EMPLOYER", role: "RECRUITER" }] } });
  });
  await page.goto("/workspace/copilot");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Your request" }).fill("Prepare invitations for Fictional role.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.getByRole("checkbox", { name: "Fictional Candidate · Written" }).check();
  await page.getByRole("button", { name: "Follow-up", exact: true }).click();
  await page.getByRole("button", { name: "Preview invitations", exact: true }).click();
  await expect(page.getByText("The response describes a monitored outcome against the original rubric.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Review supporting report" })).toHaveAttribute("href", "/workspace/reports/source");
  const approve = page.getByRole("button", { name: "Approve and create invitations" });
  await expect(approve).toBeDisabled();
  expect(approvals).toBe(0);
  await page.getByRole("checkbox", { name: "I approve these exact invitations and the credit cost." }).check();
  await expect(approve).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("nova-approval.png"), fullPage: true });
  await approve.click();
  await expect(page.getByRole("link", { name: "Open secure candidate invitation" })).toBeVisible();
  expect(approvals).toBe(1);
  await page.reload();
  await page.getByText("History", { exact: true }).click();
  await page.getByRole("button", { name: /COMPLETED · Review evidence/ }).click();
  await expect(page.getByRole("link", { name: "Open secure candidate invitation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and create invitations" })).toHaveCount(0);
  expect(approvals).toBe(1);
  await page.getByRole("textbox", { name: "Your request" }).fill("Explain the evidence in more detail.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByText("Fresh evidence was retrieved for this follow-up.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and create invitations" })).toHaveCount(0);
  expect(followUps).toBe(1);
  expect(approvals).toBe(1);
});
