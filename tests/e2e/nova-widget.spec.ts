import { expect, test } from "@playwright/test";

test("Nova launcher is available on public pages without fetching recruiter data", async ({ page }) => {
  let novaRequests = 0;
  await page.route("**/v1/nova/**", (route) => { novaRequests++; return route.fulfill({ status: 401, json: {} }); });
  await page.goto("/login");
  const launcher = page.getByRole("button", { name: "Open Nova chat", exact: true });
  await expect(launcher).toBeVisible();
  await launcher.click();
  const panel = page.getByRole("region", { name: "Nova chat", exact: true });
  await expect(panel.getByRole("link", { name: "Sign in to use Nova" })).toBeVisible();
  expect(novaRequests).toBe(0);
  await panel.getByRole("button", { name: "Minimize Nova chat", exact: true }).press("Escape");
  await expect(panel).toBeHidden();
  await expect(launcher).toBeFocused();
});

test("Nova widget keeps the draft on minimize and workspace navigation", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("northstar.organizationId", "fictional-widget-org"));
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/nova/status")) return route.fulfill({ json: { configured: true, model: "explicit-widget-test-double", reason: null } });
    if (path.endsWith("/nova/options")) return route.fulfill({ json: { roles: [{ id: "role", title: "Fictional widget role", rounds: [] }], assessments: [], nextCursor: null } });
    if (path.endsWith("/nova/runs")) return route.fulfill({ json: { runs: [] } });
    if (path === "/v1/jobs") return route.fulfill({ json: { data: [] } });
    if (path === "/v1/workspace") return route.fulfill({ json: { organization: { name: "Fictional widget workspace", type: "EMPLOYER", creditBalance: 100 }, membership: { role: "RECRUITER" } } });
    return route.fulfill({ json: { user: { name: "Fictional recruiter" }, organizations: [{ id: "fictional-widget-org", name: "Fictional widget workspace", type: "EMPLOYER", role: "RECRUITER" }] } });
  });
  await page.goto("/workspace/copilot");
  await page.getByRole("button", { name: "Open Nova chat", exact: true }).click();
  const panel = page.getByRole("region", { name: "Nova chat", exact: true });
  await expect(panel.getByText("What would you like to get done?", { exact: true })).toBeVisible();
  await expect(panel.getByRole("textbox", { name: "Your request" })).toHaveValue("");
  await expect(panel.getByRole("combobox")).toHaveCount(0);
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Help me invite candidates", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("nova-chat-welcome.png"), fullPage: true });
  await panel.getByRole("textbox", { name: "Your request" }).fill("Explain the evidence without ranking candidates.");
  await panel.getByRole("button", { name: "Minimize Nova chat", exact: true }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "Open Nova chat", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "Your request" })).toHaveValue("Explain the evidence without ranking candidates.");
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await expect(page).toHaveURL(/\/workspace\/jobs$/);
  await expect(panel.getByRole("textbox", { name: "Your request" })).toHaveValue("Explain the evidence without ranking candidates.");
  const box = await panel.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: testInfo.outputPath("nova-floating-chat.png"), fullPage: true });
  await page.goto("/login");
  await page.getByRole("button", { name: "Open Nova chat", exact: true }).click();
  await expect(panel.getByRole("textbox", { name: "Your request" })).toHaveCount(0);
  await expect(panel.getByRole("link", { name: "Sign in to use Nova" })).toBeVisible();
});

test("Nova chat clears sent drafts and continues the conversation with fresh authorization", async ({ page }) => {
  let requests = 0;
  await page.addInitScript(() => localStorage.setItem("northstar.organizationId", "fictional-chat-org"));
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/nova/status")) return route.fulfill({ json: { configured: true, model: "explicit-chat-test-double", reason: null } });
    if (path.endsWith("/nova/options")) return route.fulfill({ json: { roles: [{ id: "role", title: "Platform Engineer", rounds: [] }], assessments: [{ id: "evidence-source", candidateId: "person", candidate: { name: "Fictional Person" }, round: { title: "Written", sequence: 1 }, evidenceCount: 1 }], nextCursor: null } });
    if (path.endsWith("/nova/runs") && request.method() === "POST") {
      const payload = request.postDataJSON();
      expect(payload.selection).toEqual({ jobId: "role", selectedAssessmentIds: ["evidence-source"] });
      if (requests++) expect(payload.parentRunId).toBe("first");
      else expect(payload.parentRunId).toBeUndefined();
      return route.fulfill({ status: 202, json: { id: requests === 1 ? "first" : "second" } });
    }
    if (/\/nova\/runs\/(first|second)$/.test(path)) {
      const second = path.endsWith("second");
      return route.fulfill({ json: { id: second ? "second" : "first", status: "READY", message: second ? "Explain further." : "Review Platform Engineer assessments.", context: { jobId: "role", selectedAssessmentIds: ["evidence-source"] }, response: { message: second ? "Fresh evidence reviewed for your reply." : "Evidence reviewed.", summaries: [] }, proposals: [], calls: [], modelSteps: 1 } });
    }
    if (path.endsWith("/nova/runs")) return route.fulfill({ json: { runs: [] } });
    return route.fulfill({ json: { organization: { name: "Fictional chat workspace", type: "EMPLOYER", creditBalance: 100 }, membership: { role: "RECRUITER" }, user: { name: "Fictional recruiter" }, organizations: [] } });
  });
  await page.goto("/workspace/copilot");
  await page.getByRole("button", { name: "Open Nova chat" }).click();
  const panel = page.getByRole("region", { name: "Nova chat" });
  await panel.getByRole("textbox", { name: "Your request" }).fill("Review Platform Engineer assessments.");
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByText("Evidence reviewed.", { exact: true })).toBeVisible();
  await expect(panel.getByRole("checkbox")).toHaveCount(0);
  await expect(panel.getByRole("textbox", { name: "Your request" })).toHaveValue("");
  await panel.getByRole("textbox", { name: "Your request" }).fill("Explain further.");
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByText("Fresh evidence reviewed for your reply.")).toBeVisible();
  expect(requests).toBe(2);
});

test("Nova asks about ambiguous jobs instead of guessing or choosing candidates", async ({ page }) => {
  let requests = 0;
  await page.addInitScript(() => localStorage.setItem("northstar.organizationId", "fictional-ambiguous-org"));
  const roles = [{ id: "senior", title: "Senior Platform Engineer", rounds: [{ id: "next", title: "Human interview", sequence: 2 }] }, { id: "junior", title: "Junior Platform Engineer", rounds: [] }];
  await page.route("**/v1/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/nova/status")) return route.fulfill({ json: { configured: true, model: "explicit-test-double", reason: null } });
    if (path.endsWith("/nova/options")) return route.fulfill({ json: { roles, assessments: [{ id: "source", candidateId: "person", candidate: { name: "Fictional Person" }, round: { title: "Written", sequence: 1 }, evidenceCount: 1 }], nextCursor: null } });
    if (path.endsWith("/nova/runs") && route.request().method() === "POST") { requests++; return route.fulfill({ status: 500, json: {} }); }
    if (path.endsWith("/nova/runs")) return route.fulfill({ json: { runs: [] } });
    return route.fulfill({ json: { organization: { name: "Fictional workspace", type: "EMPLOYER", creditBalance: 100 }, membership: { role: "RECRUITER" }, user: { name: "Recruiter" }, organizations: [] } });
  });
  await page.goto("/workspace/copilot");
  await page.getByRole("button", { name: "Open Nova chat" }).click();
  const panel = page.getByRole("region", { name: "Nova chat" });
  await panel.getByRole("textbox", { name: "Your request" }).fill("Prepare invitations for platform engineers.");
  await panel.getByRole("button", { name: "Send message" }).click();
  await expect(panel.getByText("I found more than one matching job. Which one do you mean?")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Senior Platform Engineer", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Junior Platform Engineer", exact: true })).toBeVisible();
  expect(requests).toBe(0);
  await panel.getByRole("button", { name: "Senior Platform Engineer", exact: true }).click();
  const person = panel.getByRole("checkbox", { name: "Fictional Person · Written" });
  await expect(person).not.toBeChecked();
  await expect(panel.getByRole("button", { name: "Preview invitations" })).toBeDisabled();
  await expect(panel.getByRole("combobox")).toHaveCount(0);
  expect(requests).toBe(0);
});
