import { expect, test } from "@playwright/test";

test("assessment drafts restore authored questions and resume across pages", async ({ page }) => {
  let revision = 1;
  let draft = { answers: { authored1: "Previously saved answer" } as Record<string, string>, questionIndex: 0 };
  let submitted = false;
  await page.context().route("**/candidate/assessments/draft-fixture**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return route.fulfill({ json: { assessment: { id: "fixture", type: "HUMAN_INTERVIEW", status: submitted ? "PROCESSING" : "IN_PROGRESS", candidateName: "Fictional Candidate", roundTitle: "Authored round", jobTitle: "Fictional role", durationMinutes: 20, proctoringEnabled: false, startedAt: new Date(Date.now() - 300_000).toISOString(), questions: [{ id: "authored1", label: "Explain your own implementation." }, { id: "authored2", label: "Which trade-off would you revisit?" }], draft, draftRevision: revision, draftSavedAt: new Date().toISOString() } } });
    if (request.url().endsWith("/draft")) {
      const body = request.postDataJSON();
      if (body.revision !== revision) return route.fulfill({ status: 409, json: { error: { message: "A newer draft exists. Reload before continuing." } } });
      revision += 1;
      draft = { answers: body.answers, questionIndex: body.questionIndex };
      return route.fulfill({ json: { revision, savedAt: new Date().toISOString() } });
    }
    if (request.url().endsWith("/submit")) {
      expect(request.postDataJSON().draftRevision).toBe(revision);
      expect(request.postDataJSON().answers.authored2).toBe("A revised trade-off supported by evidence.");
      submitted = true;
      return route.fulfill({ json: { assessment: { id: "fixture", status: "PROCESSING", score: null, summary: null }, processing: "queued" } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/assess/draft-fixture");
  await expect(page.getByRole("heading", { name: "Explain your own implementation." })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Your answer" })).toHaveValue("Previously saved answer");
  await expect(page.getByText(/14:\d{2}|15:00/)).toBeVisible();
  await page.getByRole("textbox", { name: "Your answer" }).fill("Updated answer persisted to the server.");
  await expect(page.getByText(/Saved to session at/)).toBeVisible();
  expect(draft.answers.authored1).toBe("Updated answer persisted to the server.");
  const resumed = await page.context().newPage();
  await resumed.goto("/assess/draft-fixture");
  await expect(resumed.getByRole("textbox", { name: "Your answer" })).toHaveValue("Updated answer persisted to the server.");
  await resumed.getByRole("button", { name: "Save and continue" }).click();
  await resumed.getByRole("textbox", { name: "Your answer" }).fill("A revised trade-off supported by evidence.");
  await resumed.getByRole("button", { name: "Submit assessment" }).click();
  await expect(resumed.getByRole("heading", { name: "Your evidence is on its way." })).toBeVisible();
  await resumed.reload();
  await expect(resumed.getByText("Secure evaluation is in progress.")).toBeVisible();
  await resumed.close();
});

test("a draft save failure preserves typed text and offers explicit recovery", async ({ page }) => {
  await page.route("**/candidate/assessments/conflict-fixture**", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { assessment: { id: "fixture", type: "HUMAN_INTERVIEW", status: "IN_PROGRESS", roundTitle: "Draft conflict", jobTitle: "Fictional role", durationMinutes: 20, proctoringEnabled: false, questions: [{ id: "q1", label: "Explain the evidence." }], draft: { answers: { q1: "Saved on another device" }, questionIndex: 0 }, draftRevision: 2 } } });
    return route.fulfill({ status: 409, json: { error: { message: "A newer draft exists. Reload before continuing." } } });
  });
  await page.goto("/assess/conflict-fixture");
  await page.getByRole("textbox", { name: "Your answer" }).fill("Unsaved answer remains available to copy.");
  await expect(page.getByRole("alert").filter({ hasText: "A newer draft exists" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Your answer" })).toHaveValue("Unsaved answer remains available to copy.");
  await expect(page.getByRole("button", { name: "Submit assessment" })).toBeDisabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reload saved draft" }).click();
  await expect(page.getByRole("textbox", { name: "Your answer" })).toHaveValue("Saved on another device");
});
