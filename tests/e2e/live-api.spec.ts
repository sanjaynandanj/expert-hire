import { expect, test } from "@playwright/test";

test.describe("live PostgreSQL workspace", () => {
  test.skip(process.env.LIVE_API_E2E !== "1", "Requires the local Docker stack, migration, seed, and API server.");

  test("signs in and creates a tenant-scoped candidate", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByText("Live workspace").first()).toBeVisible();

    await page.getByRole("link", { name: "Candidates" }).click();
    await expect(page.getByText("Live PostgreSQL data")).toBeVisible();
    await page.getByRole("button", { name: "Add candidate" }).click();

    const suffix = Date.now();
    await page.getByLabel("Full name").fill("Rhea Livecheck");
    await page.getByLabel("Email").fill(`rhea.livecheck.${suffix}@candidate.test`);
    await page.getByLabel("Headline").fill("Reliability engineer");
    await page.getByRole("button", { name: "Add candidate", exact: true }).last().click();

    await expect(page.getByText("Rhea Livecheck").first()).toBeVisible();
    await expect(page.getByText("Reliability engineer").first()).toBeVisible();

    await page.getByRole("link", { name: "Pipeline" }).click();
    const maya = page.locator(".candidate-card").filter({ hasText: "Maya Chen" });
    const stageSelect = maya.getByRole("combobox", { name: "Move Maya Chen to stage" });
    await expect(stageSelect).toBeVisible();
    await stageSelect.selectOption({ label: "Interview" });
    await expect(stageSelect.locator("option:checked")).toHaveText("Interview");
    await page.getByRole("button", { name: "Add stage" }).first().click();
    await page.getByLabel("Stage name").fill(`Custom stage ${Date.now()}`);
    await page.getByRole("button", { name: "Add stage" }).last().click();
    await expect(page.locator(".kanban-head").last()).toContainText("Custom stage");
    await page.getByRole("link", { name: "Jobs" }).click();
    const roleStatus = page.getByRole("combobox", { name: "Change Senior Platform Engineer status" });
    await expect(roleStatus).toHaveValue("OPEN");
    await roleStatus.selectOption("PAUSED");
    await expect(roleStatus).toHaveValue("PAUSED");
    await roleStatus.selectOption("OPEN");
    await expect(roleStatus).toHaveValue("OPEN");
  });

  test("placement staff can preview eligibility and record a student application", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email address").fill("placements@riverton.test");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/workspace\/university$/);
    await expect(page.getByText("Live university data")).toBeVisible();
    await page.getByLabel("Student").selectOption({ label: "Anaya Desai · RVU-CSE-1077" });
    const appliedTag = page.getByText("Applied", { exact: true });
    if (!(await appliedTag.isVisible().catch(() => false))) {
      await expect(page.getByRole("button", { name: "Apply student" })).toBeEnabled();
      await page.getByRole("button", { name: "Apply student" }).click();
      await expect(page.getByRole("status")).toContainText("Application recorded");
    }
    await expect(appliedTag).toBeVisible();
    const applicationRow = page.locator(".application-review-row").filter({ hasText: "Anaya Desai" });
    await expect(applicationRow).toBeVisible();
    const applicationStatus = applicationRow.getByRole("combobox", { name: "Change Anaya Desai application status" });
    if (await applicationStatus.count()) {
      if (await applicationStatus.inputValue() === "APPLIED") {
        await applicationStatus.selectOption("SHORTLISTED");
        await expect(applicationRow.getByRole("combobox", { name: "Change Anaya Desai application status" })).toHaveValue("SHORTLISTED");
      }
      if (await applicationRow.getByRole("combobox", { name: "Change Anaya Desai application status" }).count() && await applicationRow.getByRole("combobox", { name: "Change Anaya Desai application status" }).inputValue() === "SHORTLISTED") {
        await applicationRow.getByRole("combobox", { name: "Change Anaya Desai application status" }).selectOption("INTERVIEWING");
        await expect(applicationRow.getByRole("button", { name: "Issue offer" })).toBeVisible();
      }
    }
    if (await applicationRow.getByRole("button", { name: "Issue offer" }).count()) {
      await applicationRow.getByRole("button", { name: "Issue offer" }).click();
      await applicationRow.getByLabel("Annual CTC").fill("1800000");
      await applicationRow.getByLabel("Joining date").fill("2027-07-01");
      await applicationRow.getByRole("button", { name: "Issue offer" }).click();
    }
    const offerOutcome = applicationRow.getByRole("combobox", { name: "Change Anaya Desai offer outcome" });
    if (await offerOutcome.count() && await offerOutcome.inputValue() === "ROLLED") {
      await offerOutcome.selectOption("ACCEPTED");
      await expect(offerOutcome).toHaveValue("ACCEPTED");
    }
    if (await applicationRow.getByRole("combobox", { name: "Change Anaya Desai offer outcome" }).count() && await applicationRow.getByRole("combobox", { name: "Change Anaya Desai offer outcome" }).inputValue() === "ACCEPTED") {
      await applicationRow.getByRole("combobox", { name: "Change Anaya Desai offer outcome" }).selectOption("JOINED");
      await expect(applicationRow.getByRole("combobox", { name: "Change Anaya Desai offer outcome" })).toHaveValue("JOINED");
    }
    await expect(applicationRow.getByRole("combobox", { name: "Change Anaya Desai offer outcome" })).toHaveValue("JOINED");
  });

  test("placement staff can author and publish a drive", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email address").fill("placements@riverton.test");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/workspace\/university$/);
    await page.getByRole("button", { name: "Create drive" }).click();
    const title = `Live placement role ${Date.now()}`;
    await page.getByLabel("Role title").fill(title);
    await page.getByLabel("Locations (comma separated)").fill("Pune, Remote");
    await page.getByLabel("Eligible branches (comma separated)").fill("CSE");
    await page.getByLabel("Openings").fill("3");
    await page.getByLabel("Minimum CTC").fill("800000");
    await page.getByLabel("Maximum CTC").fill("1200000");
    await page.getByLabel("Minimum CGPA").fill("7");
    await page.getByLabel("Role description").fill("Join a cross-functional engineering team to build reliable products, learn from experienced mentors, and contribute to tested customer-facing features.");
    await page.getByRole("button", { name: "Save draft drive" }).click();
    const driveRow = page.locator(".evidence-row").filter({ hasText: title });
    await expect(driveRow).toBeVisible();
    const status = driveRow.getByRole("combobox", { name: `Change ${title} drive status` });
    await status.selectOption("PUBLISHED");
    await expect(status).toHaveValue("PUBLISHED");
  });

  test("workspace admins can save client fee and guarantee terms", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("link", { name: "Clients" }).click();
    await expect(page.getByText("Live PostgreSQL data")).toBeVisible();
    await page.getByRole("button", { name: "Add client" }).click();
    const clientName = `Northstar Client ${Date.now()}`;
    await page.getByLabel("Client name").fill(clientName);
    await page.getByLabel("Industry").fill("Infrastructure");
    await page.getByLabel("Fee model").selectOption("PERCENTAGE");
    await page.getByLabel("Fee amount").fill("17.5");
    await page.getByLabel("Currency").selectOption("USD");
    await page.getByLabel("Guarantee period (days)").fill("120");
    await page.getByLabel("Billing email").fill("finance@northstar.test");
    await page.getByRole("button", { name: "Save client" }).click();
    const clientRow = page.locator("tbody tr").filter({ hasText: clientName });
    await expect(clientRow).toContainText("17.5%");
    await expect(clientRow).toContainText("120 days");
    await clientRow.getByRole("combobox", { name: `Change ${clientName} status` }).selectOption("ACTIVE");
    await expect(clientRow.getByRole("combobox")).toHaveValue("ACTIVE");
  });

  test("recruiters can save candidate notes and schedule meetings", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("link", { name: "Candidates" }).click();
    const candidate = page.locator("tbody tr").filter({ hasText: "Maya Chen" });
    await candidate.getByRole("button", { name: "View notes" }).click();
    const noteText = `Follow-up note ${Date.now()}`;
    await page.getByLabel("Add a note").fill(noteText);
    await page.getByRole("button", { name: "Save note" }).click();
    await expect(page.getByText(noteText)).toBeVisible();

    await page.getByRole("link", { name: "Meetings" }).click();
    await expect(page.getByRole("heading", { name: "Meetings" })).toBeVisible();
    const meetingTitle = `Candidate sync ${Date.now()}`;
    await page.getByLabel("Title").fill(meetingTitle);
    const when = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const localDate = new Date(when.getTime() - when.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await page.getByLabel("Date and time").fill(localDate);
    await page.getByLabel("Candidate (optional)").selectOption({ label: "Maya Chen" });
    await page.getByRole("button", { name: "Schedule meeting" }).click();
    const meeting = page.locator("article").filter({ hasText: meetingTitle });
    await expect(meeting).toBeVisible();
    await meeting.getByRole("combobox", { name: `Update ${meetingTitle} status` }).selectOption("COMPLETED");
    await expect(meeting.getByRole("combobox")).toHaveValue("COMPLETED");
  });

  test("analytics uses live tenant-scoped workspace totals", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("link", { name: "Analytics" }).click();
    await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
    await expect(page.getByText("Live PostgreSQL data")).toBeVisible();
    await expect(page.getByText("Assessment completion")).toBeVisible();
    await expect(page.getByText("Active pipeline")).toBeVisible();
  });

  test("sign out revokes the active workspace session", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/workspace$/);
    const oldSession = (await page.context().cookies()).find((cookie) => cookie.name === "northstar_session");
    expect(oldSession).toBeTruthy();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/login$/);
    const response = await page.context().request.get(`${process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000"}/v1/auth/session`, { headers: { Cookie: `northstar_session=${oldSession?.value ?? ""}` } });
    expect(response.status()).toBe(401);
  });

  test("students can save private practice attempts and build readiness history", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email address").fill("kabir@riverton.test");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/practice$/);
    await expect(page.getByText(/Welcome, Kabir Menon/)).toBeVisible();
    await page.getByLabel("Your answer").fill("I made the project easier to understand by defining the key terms, sharing a clear example, and checking whether the teammate could explain the main trade-off back to me.");
    await page.getByRole("button", { name: "Save practice attempt" }).click();
    await expect(page.getByRole("status")).toContainText("Practice saved");
    await expect(page.locator(".evidence-row").first()).toContainText("Communication");
    const mechanicalDrive = page.locator(".drive-row").filter({ hasText: "Mechanical Engineering Intern" });
    const applyButton = mechanicalDrive.getByRole("button", { name: "Apply" });
    if (await applyButton.count()) {
      await expect(applyButton).toBeEnabled();
      await applyButton.click();
    }
    await expect(mechanicalDrive.getByText("Applied")).toBeVisible();
  });

  test("recruiter can issue an invite and a candidate can submit it", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "Create one live assessment per run.");
    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("link", { name: "Assessments" }).click();
    await expect(page.getByRole("heading", { name: "Assessments" })).toBeVisible();
    await page.getByLabel("Assessment round").selectOption({ label: "Senior Platform Engineer · Systems coding" });
    await page.getByRole("button", { name: "Create invitation" }).click();

    const invite = page.locator(".notice a");
    await expect(invite).toBeVisible();
    const launchUrl = await invite.getAttribute("href");
    if (!launchUrl) throw new Error("Assessment launch URL is missing.");
    await page.goto(new URL(launchUrl).pathname);
    await page.getByRole("button", { name: "Run browser check" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Accept and continue" }).click();
    await page.getByRole("button", { name: "Start assessment" }).click();

    const answer = page.getByRole("textbox", { name: "Your answer" });
    await answer.fill("I would define service objectives, partition queue traffic with idempotent consumers, use bounded retries and dead letter handling, then validate partial failure recovery.");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await answer.fill("I would measure queue age and worker saturation, identify poison messages, apply backpressure, and verify the rollback path.");
    await page.getByRole("button", { name: "Save and continue" }).click();
    await answer.fill("I changed a deployment plan when a teammate showed that it lacked an auditable rollback strategy.");
    await page.getByRole("button", { name: "Submit assessment" }).click();
    await expect(page.getByRole("heading", { name: "Your evidence is on its way." })).toBeVisible();
    await page.goto("/workspace/assessments");
    await expect(page.getByRole("heading", { name: "Assessments" })).toBeVisible();
    const newestAssessment = page.locator("tbody tr").first();
    await expect(newestAssessment).toContainText("COMPLETED", { timeout: 15_000 });
    await newestAssessment.getByRole("link", { name: "Review report" }).click();
    await expect(page.getByRole("heading", { name: "Criterion evidence" })).toBeVisible();
  });
});
