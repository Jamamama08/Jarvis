import { expect, test, type Page } from "@playwright/test";

const USER = { username: "tony", name: "Tony", password: "arc-reactor-42" };

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Username").fill(USER.username);
  await page.getByLabel("Password", { exact: true }).fill(USER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("Message", { exact: true })).toBeVisible();
}

test.describe.serial("JARVIS phase 1", () => {
  test("first-run setup creates the owner account", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("First-run setup")).toBeVisible();
    await page.getByLabel("Username").fill(USER.username);
    await page.getByLabel("Your name").fill(USER.name);
    await page.getByLabel("Password", { exact: true }).fill(USER.password);
    await page.getByLabel("Confirm password").fill("mismatch-123");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("alert")).toHaveText("Passwords do not match");
    await page.getByLabel("Confirm password").fill(USER.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(`, ${USER.name}.`)).toBeVisible();
    await expect(page.getByTestId("ai-status")).toHaveText("Claude not connected");
  });

  test("sending a message persists the conversation across reloads", async ({ page }) => {
    await signIn(page);
    await page.getByLabel("Message", { exact: true }).fill("Schedule a suit diagnostic for Friday");
    await page.keyboard.press("Enter");

    const list = page.getByTestId("message-list");
    await expect(list.locator('[data-role="user"]')).toHaveText("Schedule a suit diagnostic for Friday");
    await expect(list.locator('[data-role="system"]')).toContainText("Claude is not connected");
    await expect(page).toHaveURL(/\/c\/[0-9a-f]{32}$/);
    await expect(page.getByTestId("conversation-title")).toHaveText("Schedule a suit diagnostic for Friday");
    const sidebar = page.getByRole("navigation", { name: "Conversations" });
    await expect(sidebar.getByText("Schedule a suit diagnostic for Friday")).toBeVisible();

    await page.reload();
    await expect(page.getByTestId("message-list").locator('[data-role="user"]')).toHaveText(
      "Schedule a suit diagnostic for Friday",
    );
  });

  test("rename, pin, search and delete conversations", async ({ page }) => {
    await signIn(page);
    // second conversation
    await page.getByRole("button", { name: "New conversation" }).click();
    await page.getByLabel("Message", { exact: true }).fill("Order more palladium");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-list").locator('[data-role="system"]')).toBeVisible();

    const sidebar = page.getByRole("navigation", { name: "Conversations" });
    await sidebar.getByRole("button", { name: "Actions for Order more palladium" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await sidebar.getByLabel("Conversation title").fill("Palladium supply");
    await page.keyboard.press("Enter");
    await expect(sidebar.getByText("Palladium supply")).toBeVisible();

    await sidebar.getByRole("button", { name: "Actions for Schedule a suit diagnostic for Friday" }).click();
    await page.getByRole("menuitem", { name: "Pin" }).click();
    await expect(sidebar.getByText("Pinned")).toBeVisible();

    await page.getByLabel("Search conversations").fill("palladium");
    await expect(sidebar.getByRole("button", { name: /Schedule a suit/ })).toHaveCount(0);
    await expect(sidebar.getByText("Palladium supply")).toBeVisible();
    await page.getByLabel("Search conversations").fill("");

    page.once("dialog", (d) => d.accept());
    await sidebar.getByRole("button", { name: "Actions for Palladium supply" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(sidebar.getByText("Palladium supply")).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  });

  test("settings persist and backups can be created", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Assistant name").fill("FRIDAY");
    await page.locator(".card").filter({ has: page.getByRole("heading", { name: "Assistant" }) }).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved")).toBeVisible();
    await page.getByRole("button", { name: "Back up now" }).click();
    await expect(page.getByTestId("backup-list")).toContainText("jarvis-");
    await page.reload();
    await expect(page.getByLabel("Assistant name")).toHaveValue("FRIDAY");
    await page.getByRole("button", { name: "New conversation" }).click();
    await expect(page.getByLabel("Message", { exact: true })).toHaveAttribute("placeholder", "Message FRIDAY…");
  });

  test("sign out returns to the login screen and protects the API", async ({ page, request }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await expect(page.getByText("Welcome back")).toBeVisible();
    const res = await request.get("/api/conversations");
    expect(res.status()).toBe(401);
  });
});
