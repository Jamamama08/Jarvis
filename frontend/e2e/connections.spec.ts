import { expect, test } from "@playwright/test";

const USER = { username: "tony", name: "Tony", password: "arc-reactor-42" };
const MOCK = "http://127.0.0.1:8798";

test("connect Claude, a calendar and phone notifications from Settings", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("Username").fill(USER.username);
  await page.getByLabel("Your name").fill(USER.name);
  await page.getByLabel("Password", { exact: true }).fill(USER.password);
  await page.getByLabel("Confirm password").fill(USER.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByTestId("ai-status")).toHaveText("Claude not connected");

  await page.getByRole("button", { name: "Settings" }).click();
  const card = page.getByTestId("connections");
  await card.getByLabel("Claude API key").fill("sk-ant-api03-bad-key-0000000");
  await card.getByRole("button", { name: "Save key" }).click();
  await expect(card.getByRole("alert")).toContainText("Anthropic rejected this key");
  await card.getByLabel("Claude API key").fill("sk-ant-api03-good-key-1234567");
  await card.getByRole("button", { name: "Save key" }).click();
  await expect(card.getByRole("status").first()).toContainText("Claude is connected");
  await expect(card).not.toContainText("good-key");
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByTestId("ai-status")).toHaveText("Claude online"); // no restart needed

  // The key is stored server-side only: it never appears in API responses.
  const token = await page.evaluate(() => localStorage.getItem("jarvis.token"));
  const integrations = await request.get("/api/integrations", { headers: { Authorization: `Bearer ${token}` } });
  expect(await integrations.text()).not.toContain("good-key");

  await page.getByRole("button", { name: "Settings" }).click();
  await card.getByLabel("Calendar URL").fill(`${MOCK}/__cal.ics`);
  await card.getByRole("button", { name: "Save & test" }).first().click();
  await expect(card.getByText(/1 event\(s\) in the next 7 days/)).toBeVisible();

  await card.getByLabel("Phone notifications URL").fill(`${MOCK}/__hook`);
  await card.getByRole("button", { name: "Save & test" }).nth(1).click();
  await expect(card.getByText("Sent a test notification (json).")).toBeVisible();
  const hooks = await (await request.get(`${MOCK}/__hooks`)).json();
  expect(JSON.parse(hooks.at(-1))).toEqual({ title: "JARVIS", message: "Test notification: it works." });
  await expect(card).toContainText("Connected via json");
});
