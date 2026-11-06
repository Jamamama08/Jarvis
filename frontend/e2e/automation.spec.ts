import { expect, test, type Page } from "@playwright/test";

const USER = { username: "tony", name: "Tony", password: "arc-reactor-42" };
const PAGE = "http://127.0.0.1:8798/__page";

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

async function openAutomationTab(page: Page) {
  await page.getByRole("button", { name: "Tools" }).click();
  await page.getByRole("tab", { name: /Browser & apps/ }).click();
}

test.describe.serial("JARVIS phase 6: browser and desktop", () => {
  test("JARVIS opens a web page in its own browser", async ({ page }) => {
    await login(page);
    await ask(page, `browse ${PAGE}`);
    const card = lastReply(page).getByTestId("tool-card");
    await expect(card).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
    await expect(card).toContainText("Open web page");
    await expect(lastReply(page)).toContainText("Title: Malibu Weather");
    await expect(lastReply(page)).toContainText("Sunny, 24 degrees.");
    await expect(lastReply(page)).toContainText('[1] link "Refresh"');

    await openAutomationTab(page);
    await expect(page.getByTestId("browser-url")).toContainText("/__page");
    await page.getByRole("button", { name: "Close browser" }).click();
    await expect(page.getByTestId("browser-url")).toHaveCount(0);
  });

  test("approve a desktop app, then JARVIS launches it after asking", async ({ page }) => {
    await login(page);
    await openAutomationTab(page);
    const panel = page.getByTestId("desktop-panel");
    await panel.getByLabel("App name").fill("Node");
    await panel.getByLabel("App path").fill("relative/path");
    await panel.getByRole("button", { name: "Approve app" }).click();
    await expect(panel.getByRole("alert")).toContainText("full path");
    await panel.getByLabel("App path").fill(process.execPath);
    await panel.getByLabel("Fixed arguments").fill("-e 0");
    await panel.getByLabel("App description").fill("Test runtime");
    await panel.getByRole("button", { name: "Approve app" }).click();
    await expect(panel.getByTestId("desktop-apps")).toContainText("Node");
    await expect(panel.getByTestId("desktop-apps")).toContainText(`${process.execPath} -e 0`);

    await ask(page, "open app Node");
    const card = lastReply(page).getByTestId("tool-card");
    await expect(card).toHaveAttribute("data-status", "pending_approval");
    await expect(card).toContainText(`open Node (${process.execPath})`);
    await card.getByRole("button", { name: "Allow" }).click();
    await expect(card).toHaveAttribute("data-status", "succeeded");
    await expect(lastReply(page)).toContainText("Tool result: Started Node (process");

    await ask(page, "open app Calculator");
    const missing = lastReply(page).getByTestId("tool-card");
    await expect(missing).toHaveAttribute("data-status", "pending_approval");
    await missing.getByRole("button", { name: "Allow" }).click();
    await expect(missing).toHaveAttribute("data-status", "failed");
    await expect(lastReply(page)).toContainText("isn't an approved app");

    await openAutomationTab(page);
    await page.getByRole("button", { name: "Remove Node" }).click();
    await expect(page.getByTestId("desktop-apps")).toHaveCount(0);
  });
});
