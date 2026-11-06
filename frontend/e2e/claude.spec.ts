import { expect, test, type Page } from "@playwright/test";

const USER = { username: "tony", name: "Tony", password: "arc-reactor-42" };
const MOCK = "http://127.0.0.1:8798";

async function setupOrLogin(page: Page) {
  await page.goto("/");
  const setup = page.getByText("First-run setup");
  const login = page.getByText("Welcome back");
  await expect(setup.or(login)).toBeVisible();
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

test.describe.serial("JARVIS phase 2: Claude", () => {
  test("streams a Markdown reply and keeps context across turns", async ({ page, request }) => {
    await setupOrLogin(page);
    await expect(page.getByTestId("ai-status")).toHaveText("Claude online");

    await page.getByLabel("Message", { exact: true }).fill("Status report on the Mark 42");
    await page.keyboard.press("Enter");
    const reply = page.getByTestId("message-list").locator('[data-role="assistant"]').last();
    await expect(reply.locator("strong")).toHaveText("Acknowledged.");
    await expect(reply.locator("em")).toHaveText("Status report on the Mark 42");
    await expect(reply.locator("pre code")).toHaveText('print("ok")');
    await expect(reply).toContainText("claude-opus-5-5");
    await expect(page.getByTestId("ai-status")).toHaveText("Claude online");

    await page.getByLabel("Message", { exact: true }).fill("And the Mark 43?");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-list").locator('[data-role="assistant"]').last()).toContainText("Turn 3 of this conversation.");

    const sent = await (await request.get(`${MOCK}/__requests`)).json();
    const last = sent.at(-1);
    expect(last.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(last.system).toContain("You are JARVIS");
    expect(last.fallbacks).toBe("default");
    expect(last.cache_control).toEqual({ type: "ephemeral" });

    // Reload: the conversation, rendered as Markdown, is persisted.
    await page.reload();
    await expect(page.getByTestId("message-list").locator('[data-role="assistant"]')).toHaveCount(2);
  });

  test("stop button cancels a streaming reply and keeps the partial text", async ({ page }) => {
    await setupOrLogin(page);
    await page.getByRole("button", { name: "New conversation" }).click();
    await page.getByLabel("Message", { exact: true }).fill("Give me a slow answer");
    await page.keyboard.press("Enter");
    const reply = page.getByTestId("message-list").locator('[data-role="assistant"]').last();
    await expect(reply).toContainText("word3");
    await page.getByLabel("Stop response").click();
    await expect(reply.getByText("Response stopped")).toBeVisible();
    await expect(page.getByLabel("Send message")).toBeVisible();
    await page.reload();
    const persisted = page.getByTestId("message-list").locator('[data-role="assistant"]').last();
    await expect(persisted.getByText("Response stopped")).toBeVisible();
    await expect(persisted).not.toContainText("word199");
  });

  test("model and effort preferences are sent to Claude, and usage is reported", async ({ page, request }) => {
    await setupOrLogin(page);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Claude model").selectOption("claude-sonnet-5-5");
    await page.getByLabel("Effort").selectOption("low");
    await page.getByRole("button", { name: "Save" }).nth(1).click();
    await expect(page.getByText("Saved")).toBeVisible();
    await expect(page.getByTestId("usage-totals")).toContainText("Requests");

    await page.getByRole("button", { name: "New conversation" }).click();
    await page.getByLabel("Message", { exact: true }).fill("Quick one");
    await page.keyboard.press("Enter");
    const reply = page.getByTestId("message-list").locator('[data-role="assistant"]').last();
    await expect(reply).toContainText("claude-sonnet-5-5");
    await expect(reply.locator("pre code")).toHaveText('print("ok")'); // reply finished
    await expect(page.getByLabel("Send message")).toBeVisible();

    const last = (await (await request.get(`${MOCK}/__requests`)).json()).at(-1);
    expect(last.model).toBe("claude-sonnet-5-5");
    expect(last.output_config).toEqual({ effort: "low" });

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByText("claude-sonnet-5-5", { exact: true })).toBeVisible();
  });
});
