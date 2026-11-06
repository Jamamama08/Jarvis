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

async function lastRequest(page: Page) {
  const sent = await (await page.request.get(`${MOCK}/__requests`)).json();
  return sent.at(-1);
}

test.describe.serial("JARVIS phase 3: memory", () => {
  test("add, deduplicate, search, edit and view history", async ({ page }) => {
    await setupOrLogin(page);
    await page.getByRole("button", { name: "Memory" }).click();
    await page.getByRole("button", { name: "Add a memory" }).click();
    await page.getByLabel("What should JARVIS remember?").fill("Prefers to be called Boss.");
    await page.getByLabel("Importance").selectOption("5");
    await page.getByRole("button", { name: "Save memory" }).click();
    const list = page.getByTestId("memory-list");
    await expect(list.getByText("Prefers to be called Boss.")).toBeVisible();

    await page.getByLabel("What should JARVIS remember?").fill("prefers to be CALLED boss");
    await page.getByRole("button", { name: "Save memory" }).click();
    await expect(page.getByRole("alert")).toContainText("already exists");

    await page.getByLabel("Search memories").fill("boss");
    await expect(list.getByTestId("memory-card")).toHaveCount(1);
    await page.getByLabel("Search memories").fill("zzzz");
    await expect(page.getByText("No memories match.")).toBeVisible();
    await page.getByLabel("Search memories").fill("");

    const card = list.getByTestId("memory-card").first();
    await card.getByRole("button", { name: "Edit" }).click();
    await card.getByLabel("Memory content").fill("Prefers to be called Boss or Tony.");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(list.getByText("Prefers to be called Boss or Tony.")).toBeVisible();
    await card.getByRole("button", { name: "History" }).click();
    const history = card.getByTestId("memory-history");
    await expect(history).toContainText("Edited");
    await expect(history).toContainText("Prefers to be called Boss.");
    await expect(history).toContainText("Created");
  });

  test("approved memories are sent with chat messages", async ({ page }) => {
    await setupOrLogin(page);
    await page.getByRole("button", { name: "New conversation" }).click();
    await page.getByLabel("Message", { exact: true }).fill("Good morning");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("memories-used")).toHaveText("1 memory used");
    const content = (await lastRequest(page)).messages.at(-1).content;
    expect(content[0].text).toContain("<memory_context>");
    expect(content[0].text).toContain("Prefers to be called Boss or Tony.");
    expect(content[1].text).toBe("Good morning");
  });

  test("Claude suggests memories, which wait for approval", async ({ page }) => {
    await setupOrLogin(page);
    await page.getByRole("button", { name: "New conversation" }).click();
    await page.getByLabel("Message", { exact: true }).fill("I'm vegetarian, and I'm training for a half marathon in March.");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-list").locator('[data-role="assistant"] pre code')).toBeVisible();
    await page.getByRole("button", { name: "Suggest memories" }).click();
    await expect(page.getByRole("status")).toContainText("2 memory suggestions ready for your review");
    expect((await lastRequest(page)).output_config.format.type).toBe("json_schema");

    await page.getByRole("button", { name: "Review" }).click();
    await page.getByRole("tab", { name: /Suggestions/ }).click();
    const list = page.getByTestId("memory-list");
    await expect(list.getByTestId("memory-card")).toHaveCount(2);
    await expect(list.getByText("Suggested by Claude").first()).toBeVisible();

    const veg = list.getByTestId("memory-card").filter({ hasText: "Is vegetarian." });
    await veg.getByRole("button", { name: "Approve" }).click();
    const run = list.getByTestId("memory-card").filter({ hasText: "half marathon" });
    await run.getByRole("button", { name: "Reject" }).click();
    await expect(page.getByText("No suggestions waiting.")).toBeVisible();

    await page.getByRole("tab", { name: /Saved/ }).click();
    await expect(page.getByTestId("memory-list").getByTestId("memory-card")).toHaveCount(2);

    // Delete with history purge, then check the activity log.
    const saved = page.getByTestId("memory-list").getByTestId("memory-card").filter({ hasText: "Is vegetarian." });
    await saved.getByRole("button", { name: "Delete" }).click();
    await saved.getByLabel(/Also erase its change history/).check();
    await saved.getByRole("button", { name: "Delete permanently" }).click();
    await expect(page.getByTestId("memory-list").getByTestId("memory-card")).toHaveCount(1);
    await page.getByRole("tab", { name: /Activity/ }).click();
    const activity = page.getByTestId("memory-history");
    await expect(activity).toContainText("Rejected");
    await expect(activity).not.toContainText("Is vegetarian.");
  });

  test("projects track status and progress notes", async ({ page }) => {
    await setupOrLogin(page);
    await page.getByRole("button", { name: "Memory" }).click();
    await page.getByRole("tab", { name: /Projects/ }).click();
    await page.getByLabel("Project name").fill("Mark 50");
    await page.getByLabel("Description").fill("Nanotech suit");
    await page.getByRole("button", { name: "Add project" }).click();
    const card = page.getByTestId("project-card");
    await expect(card).toContainText("Mark 50");
    await card.getByLabel("Status of Mark 50").selectOption("paused");
    await card.getByLabel("Progress notes").fill("Waiting on nanite supply.");
    await card.getByRole("button", { name: "Save notes" }).click();
    await expect(card.getByText("Saved")).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: /Projects/ }).click();
    await expect(page.getByTestId("project-card").getByLabel("Progress notes")).toHaveValue("Waiting on nanite supply.");
    await expect(page.getByTestId("project-card").getByLabel("Status of Mark 50")).toHaveValue("paused");
  });
});
