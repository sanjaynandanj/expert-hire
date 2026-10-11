import { expect, test } from "@playwright/test";

test("saved rounds can be retired/restored and retired rounds are absent from invitations", async ({ page }) => {
  let retiredAt: string | null = null;
  const job = () => ({ id: "retirement-job", title: "Fictional role", status: "OPEN", location: null, description: "Fictional role used only for browser retirement verification.", requirements: [{ id: "requirement", name: "Reviewable evidence", weight: 100 }], rounds: [{ id: "retirement-round", title: "Review round", type: "HUMAN_INTERVIEW", sequence: 1, durationMinutes: 20, retiredAt }] });
  await page.addInitScript(() => window.localStorage.setItem("northstar.organizationId", "fixture-org"));
  await page.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/retirement")) {
      const body = route.request().postDataJSON();
      expect(body.expectedRetired).toBe(!!retiredAt);
      retiredAt = body.retired ? new Date().toISOString() : null;
      return route.fulfill({ json: job().rounds[0] });
    }
    if (path.endsWith("/jobs")) return route.fulfill({ json: { data: [job()] } });
    if (path.endsWith("/candidates")) return route.fulfill({ json: { data: [{ id: "candidate", name: "Fictional Candidate", email: "fixture@example.test" }] } });
    if (path.endsWith("/auth/session")) return route.fulfill({ json: { user: { name: "Fictional Reviewer" }, organizations: [{ id: "fixture-org", name: "Fictional Organization", type: "EMPLOYER", role: "OWNER" }] } });
    if (path.endsWith("/workspace")) return route.fulfill({ json: { organization: { name: "Fictional Organization", type: "EMPLOYER", creditBalance: 100 }, membership: { role: "OWNER" } } });
    return route.fulfill({ json: { data: [] } });
  });
  await page.goto("/workspace/jobs");
  await page.getByRole("button", { name: "Edit role" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Retire round", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore round", exact: true })).toBeVisible();
  await expect(page.getByText("Round 1 · retired · saved")).toBeVisible();
  await page.goto("/workspace/assessments");
  await expect(page.getByLabel("Assessment round").locator("option")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create invitation" })).toBeDisabled();
  await page.goto("/workspace/jobs");
  await page.getByRole("button", { name: "Edit role" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Restore round", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retire round", exact: true })).toBeVisible();
  await page.goto("/workspace/assessments");
  await expect(page.getByLabel("Assessment round").locator("option")).toHaveText("Fictional role · Review round");
  await expect(page.getByRole("button", { name: "Create invitation" })).toBeEnabled();
});
