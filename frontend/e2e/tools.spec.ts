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

async function ask(page: Page, text: string) {
  await page.getByRole("button", { name: "New conversation" }).click();
  await page.getByLabel("Message", { exact: true }).fill(text);
  await page.keyboard.press("Enter");
}

const lastReply = (page: Page) => page.getByTestId("message-list").locator('[data-role="assistant"]').last();

test.describe.serial("JARVIS phase 5: tools", () => {
  test("automatic tools run without asking and show their result", async ({ page }) => {
    await login(page);
    await ask(page, "calculate 1250 * 0.15");
    const card = lastReply(page).getByTestId("tool-card");
    await expect(card).toHaveAttribute("data-status", "succeeded");
    await expect(card).toContainText("Calculator");
    await expect(card).toContainText("1250 * 0.15");
    await expect(lastReply(page)).toContainText("Tool result: 1250 * 0.15 = 187.5");
    await card.getByRole("button").first().click();
    await expect(card.locator("pre")).toHaveText("1250 * 0.15 = 187.5");
  });

  test("restricted tools wait for approval, then run", async ({ page }) => {
    await login(page);
    await ask(page, "save a note");
    const card = lastReply(page).getByTestId("tool-card");
    await expect(card).toHaveAttribute("data-status", "pending_approval");
    await expect(card.getByTestId("tool-input")).toContainText("notes/todo.md");
    await expect(page.getByTestId("tool-activity")).toContainText("Approval needed: Write file");
    await card.getByRole("button", { name: "Allow" }).click();
    await expect(card).toHaveAttribute("data-status", "succeeded");
    await expect(lastReply(page)).toContainText("Created notes/todo.md (9 bytes)");
    await expect(page.getByTestId("tool-activity")).toContainText("No tools active");
    await page.reload();
    await expect(lastReply(page).getByTestId("tool-card")).toHaveAttribute("data-status", "succeeded");
  });

  test("sensitive tools can be declined", async ({ page }) => {
    await login(page);
    await ask(page, "delete the note");
    const card = lastReply(page).getByTestId("tool-card");
    await expect(card).toHaveAttribute("data-status", "pending_approval");
    await expect(card).toContainText("sensitive action");
    await expect(card.getByText(/Always allow/)).toHaveCount(0);
    await card.getByRole("button", { name: "Deny" }).click();
    await expect(card).toHaveAttribute("data-status", "denied");
    await expect(lastReply(page)).toContainText("Tool result (error): The user did not approve delete_file");
  });

  test("permissions page: block a tool, see the activity log, web search is opt-in", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "Tools" }).click();
    await expect(page.getByTestId("workspace-dir")).toContainText("workspace");
    await expect(page.getByText(/\$10 per 1,000 searches/).first()).toBeVisible();
    await expect(page.getByLabel("Sensitive actions").locator("option")).toHaveText(["Ask me first", "Never"]);
    await page.getByLabel("Permission for write_file").selectOption("deny");
    await expect(page.getByLabel("Permission for write_file")).toHaveValue("deny");

    await ask(page, "save a note");
    const card = lastReply(page).getByTestId("tool-card");
    await expect(card).toHaveAttribute("data-status", "denied");
    await expect(lastReply(page)).toContainText("permission settings block write_file");

    await page.getByRole("button", { name: "Tools" }).click();
    await page.getByRole("button", { name: "Use level setting" }).click();
    await expect(page.getByLabel("Permission for write_file")).toHaveValue("ask");
    await page.getByRole("tab", { name: "Activity log" }).click();
    const log = page.getByTestId("tool-log");
    await expect(log).toContainText("Calculator");
    await expect(log).toContainText("Delete file");
    await expect(log.getByText("succeeded").first()).toBeVisible();
  });

  test("task list: JARVIS adds tasks, you complete them", async ({ page }) => {
    await login(page);
    await ask(page, "add task: Renew passport");
    await expect(lastReply(page).getByTestId("tool-card")).toHaveAttribute("data-status", "succeeded");
    await page.getByRole("button", { name: "Tasks" }).click();
    const item = page.getByTestId("task-item").filter({ hasText: "Renew passport" });
    await expect(item).toContainText("from conversation");
    await item.getByRole("button", { name: "Complete Renew passport" }).click();
    await expect(page.getByText("Done", { exact: true })).toBeVisible();
    await expect(page.getByTestId("task-item").filter({ hasText: "Renew passport" }).getByRole("button", { name: "Reopen Renew passport" })).toBeVisible();
    await page.getByLabel("New task").fill("Call Happy");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByTestId("task-item").filter({ hasText: "Call Happy" })).toBeVisible();
  });
});
