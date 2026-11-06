import { expect, test, type Page } from "@playwright/test";

const USER = { username: "tony", name: "Tony", password: "arc-reactor-42" };

async function login(page: Page) {
  await page.goto("/");
  const setup = page.getByText("First-run setup");
  const welcome = page.getByText("Welcome back");
  await expect(setup.or(welcome)).toBeVisible();
  await page.getByLabel("Username").fill(USER.username);
  await page.getByLabel("Password", { exact: true }).fill(USER.password);
  if (await setup.isVisible()) {
    await page.getByLabel("Your name").fill(USER.name);
    await page.getByLabel("Confirm password").fill(USER.password);
    await page.getByRole("button", { name: "Create account" }).click();
  } else {
    await page.getByRole("button", { name: "Sign in" }).click();
  }
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
}

test.describe.serial("JARVIS phase 7: autonomous tasks", () => {
  test("plan, parallel research, approval, verified result", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "Tasks" }).click();
    await page.getByLabel("Give JARVIS a goal to work on by itself").fill("Compare the Mark 42 and Mark 50 suits and save a report");
    await page.getByRole("button", { name: "Start task" }).click();

    const task = page.getByTestId("agent-task").first();
    await expect(task).toHaveAttribute("data-status", "waiting_approval", { timeout: 15_000 });
    await expect(page.getByTestId("tasks-badge")).toHaveText("1", { timeout: 10_000 });
    const detail = task.getByTestId("agent-task-detail");
    await expect(detail).toContainText("Research both suits in parallel");
    const steps = detail.getByTestId("task-step");
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText("parallel, read-only");
    await expect(steps.nth(2)).toContainText("after 1, 2");
    await expect(steps.nth(0)).toHaveAttribute("data-status", "completed");
    await expect(steps.nth(1)).toHaveAttribute("data-status", "completed");
    await expect(task.getByTestId("task-progress")).toHaveText("2/3 steps");

    const approval = detail.getByTestId("tool-card").filter({ hasText: "Write file" });
    await expect(approval).toContainText("comparison.md");
    await approval.getByRole("button", { name: "Allow" }).click();

    await expect(task).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
    await expect(detail.getByTestId("task-result")).toContainText("All done.");
    await expect(detail.getByTestId("task-result")).toContainText("Result (verified)");
    await expect(task.getByTestId("task-progress")).toHaveText("3/3 steps");
    await steps.nth(2).getByRole("button").click();
    await expect(steps.nth(2).getByTestId("tool-card")).toHaveAttribute("data-status", "succeeded");
    await expect(page.getByTestId("tasks-badge")).toHaveCount(0, { timeout: 10_000 });
  });

  test("run again, then cancel while it waits for approval", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "Tasks" }).click();
    const first = page.getByTestId("agent-task").first();
    await first.getByRole("button").first().click();
    await first.getByRole("button", { name: "Run again" }).click();
    await expect(page.getByTestId("agent-task")).toHaveCount(2);
    const rerun = page.getByTestId("agent-task").first();
    await expect(rerun).toHaveAttribute("data-status", "waiting_approval", { timeout: 15_000 });
    await rerun.getByRole("button").first().click();
    await rerun.getByRole("button", { name: "Cancel task" }).click();
    await expect(rerun).toHaveAttribute("data-status", "cancelled", { timeout: 10_000 });
    await expect(rerun.getByTestId("task-step").nth(2)).toHaveAttribute("data-status", "cancelled");
    await rerun.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByTestId("agent-task")).toHaveCount(1);
  });
});
