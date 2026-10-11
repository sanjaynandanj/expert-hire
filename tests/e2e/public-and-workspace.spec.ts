import { expect, test } from "@playwright/test";

test("public site leads to the functional product demo", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "See the whole person. Make the better call." })).toBeVisible();
  await page.getByRole("link", { name: "Open the live product" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole("heading", { name: "Good morning, Avery." })).toBeVisible();
  await expect(page.getByText("Candidate momentum")).toBeVisible();
});

test("workspace navigation exposes the recruiting workflow", async ({ page }) => {
  await page.goto("/workspace");
  await page.getByRole("link", { name: "Pipeline" }).click();
  await expect(page).toHaveURL(/\/workspace\/pipeline$/);
  await expect(page.getByRole("heading", { name: "Pipeline" })).toBeVisible();
  await expect(page.getByText("Maya Chen")).toBeVisible();

  await page.getByRole("link", { name: "Jobs" }).click();
  await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();
  await expect(page.getByText("Senior Platform Engineer")).toBeVisible();
});

test("candidate preparation dashboard renders its readiness evidence", async ({ page }) => {
  await page.goto("/practice");
  await expect(page.getByRole("heading", { name: "Build the signal before it counts." })).toBeVisible();
  await expect(page.getByText("Readiness score")).toBeVisible();
  await expect(page.getByRole("button", { name: /Technical reasoning/ })).toBeVisible();
});

test("pipeline ordering changes columns without moving candidates", async ({ page }) => {
  await page.goto("/workspace/pipeline");
  await expect(page.locator(".candidate-card h3")).toHaveCount(4);
  const people = (await page.locator(".candidate-card h3").allTextContents()).sort();
  await expect(page.locator(".kanban-head").first()).toContainText("New signal");
  await expect(page.getByRole("button", { name: "Move New signal earlier", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Move New signal later", exact: true }).click();
  await expect(page.locator(".kanban-head").first()).toContainText("Human review");
  await expect(page.locator(".kanban-head").nth(1)).toContainText("New signal");
  expect((await page.locator(".candidate-card h3").allTextContents()).sort()).toEqual(people);
  await expect(page.locator(".kanban-column").nth(1).getByRole("heading", { name: "Maya Chen" })).toBeVisible();
  await page.getByRole("button", { name: "Move New signal earlier", exact: true }).click();
  await expect(page.locator(".kanban-head").first()).toContainText("New signal");
  await expect(page.getByRole("button", { name: "Move Decision later", exact: true })).toBeDisabled();
});

test("role editor loads saved assessment rounds and supports draft removal", async ({ page }) => {
  await page.goto("/workspace/jobs");
  await page.getByRole("button", { name: "Edit role" }).first().click();
  await expect(page.getByRole("heading", { name: "Edit Senior Platform Engineer" })).toBeVisible();
  await expect(page.getByLabel("Round title")).toHaveCount(4);
  await expect(page.getByLabel("Round title").first()).toHaveValue("Resume evidence");
  await page.getByRole("button", { name: "Add round", exact: true }).click();
  await expect(page.getByLabel("Round title")).toHaveCount(5);
  await page.getByRole("button", { name: "Remove draft", exact: true }).click();
  await expect(page.getByLabel("Round title")).toHaveCount(4);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Edit Senior Platform Engineer" })).toHaveCount(0);
});

test("candidate can consent, complete, and submit a local assessment", async ({ page }) => {
  await page.goto("/assess/demo-platform-2026");
  await page.getByRole("button", { name: "Run browser check" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Accept and continue" }).click();
  await page.getByRole("button", { name: "Start assessment" }).click();

  const answer = page.getByRole("textbox", { name: "Your answer" });
  await answer.fill("I improved a distributed queue by adding bounded retries, a dead-letter path, and observable rollback criteria.");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await answer.fill("I would inspect arrival rate, worker saturation, poison messages, and downstream latency before choosing backpressure or scaling.");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await answer.fill("I changed a database migration plan after a teammate showed that the rollback path could not preserve writes.");
  await page.getByRole("button", { name: "Submit assessment" }).click();
  await expect(page.getByRole("heading", { name: "Your evidence is on its way." })).toBeVisible();
});

test("reviewer report keeps scores attached to evidence and integrity context", async ({ page }) => {
  await page.goto("/reports/demo_assessment_1");
  await expect(page.getByText("Evidence score")).toBeVisible();
  await expect(page.getByText("Strong evidence, worth a human conversation.")).toBeVisible();
  await expect(page.getByText("1 focus change")).toBeVisible();
  await expect(page.getByText("This is context, not a verdict.")).toBeVisible();
});

test("mobile public page keeps primary actions usable", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile", "Mobile-only assertion");
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Northstar home" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Explore demo" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "See the whole person. Make the better call." })).toBeVisible();
});
