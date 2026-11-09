import { expect, test, type Page } from "@playwright/test";

const USER = { username: "tony", name: "Tony", password: "arc-reactor-42" };

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

// Eight slides, so every diagram kind in the mock (flow, cycle, hierarchy, compare, ...) appears once.
const DECK = Array.from({ length: 8 }, (_, i) => `# Topic ${i + 1}\nPoint about topic ${i + 1}.`).join("\n---\n");

test.describe.serial("Learn: visual lessons from slides", () => {
  test("upload a deck, study it visually, answer questions and finish", async ({ page }) => {
    await setupOrLogin(page);
    await page.getByRole("button", { name: "Learn" }).click();
    await expect(page.getByRole("heading", { name: "Learn from your slides, visually" })).toBeVisible();

    // Unsupported file: clear error.
    await page.getByTestId("lesson-file").setInputFiles({ name: "virus.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await page.getByRole("button", { name: "Build lesson" }).click();
    await expect(page.getByRole("alert")).toContainText("Upload a PowerPoint");

    await page.getByTestId("lesson-file").setInputFiles({ name: "plants.md", mimeType: "text/markdown", buffer: Buffer.from(DECK) });
    await page.getByLabel("Explain it for").selectOption("intro");
    await page.getByRole("button", { name: "Build lesson" }).click();

    // Intro: overview from Claude.
    await expect(page).toHaveURL(/\/learn\/[0-9a-f]+$/);
    await expect(page.getByRole("heading", { level: 1, name: "How plants make food" })).toBeVisible();
    await expect(page.getByText("Explain photosynthesis")).toBeVisible();
    await expect(page.getByText("Chlorophyll", { exact: true })).toBeVisible();
    await expect(page.getByText("8 slides · Beginner level")).toBeVisible();
    await page.getByRole("button", { name: "Start lesson" }).click();

    // Scene 1: flow diagram, tap a part, walk-through, glossary term, quiz.
    const scene = page.getByTestId("lesson-scene");
    await expect(scene.getByText("Slide 1 of 8")).toBeVisible();
    await expect(page.getByTestId("lesson-visual")).toHaveAttribute("data-kind", "flow");
    await page.getByTestId("lesson-visual").getByRole("button", { name: /Water/ }).click();
    await expect(page.getByText("Water detail").last()).toBeVisible();
    await expect(scene.getByTitle("The green pigment that absorbs light.")).toBeVisible();
    await expect(page.getByText("Think of it like this")).toBeVisible();
    await page.getByRole("radio", { name: /Helium/ }).click();
    await expect(page.getByText("Not quite.")).toBeVisible();

    // Ask the tutor.
    await page.getByLabel("Question for the tutor").fill("What is a chloroplast?");
    await page.getByRole("button", { name: "Ask the tutor" }).click();
    await expect(page.getByTestId("tutor-answer")).toContainText("tiny factories");

    // Every diagram kind renders; answer the rest correctly with the keyboard to move on.
    const kinds = ["cycle", "hierarchy", "compare", "timeline", "bars", "concept_map", "layers"];
    for (const [i, kind] of kinds.entries()) {
      await page.getByRole("button", { name: "Next" }).click();
      await expect(scene.getByText(`Slide ${i + 2} of 8`)).toBeVisible();
      await expect(page.getByTestId("lesson-visual")).toHaveAttribute("data-kind", kind);
      await page.getByRole("radio", { name: /Oxygen/ }).click();
      await expect(page.getByText("Correct!")).toBeVisible();
    }
    await expect(page.getByText("45%")).toHaveCount(0); // bars were on the previous slide
    await page.keyboard.press("ArrowRight");

    // Results: 7 of 8 right, the missed slide is listed.
    const finish = page.getByTestId("lesson-finish");
    await expect(finish.getByText("You got 7 of 8 questions right.")).toBeVisible();
    await expect(finish.getByText("88%")).toBeVisible();
    await finish.getByRole("button", { name: "Scene 1: flow" }).first().click();
    await expect(scene.getByText("Slide 1 of 8")).toBeVisible();
    await expect(page.getByText("Not quite.")).toBeVisible(); // answers are remembered

    // Library shows progress; reloading resumes where you were.
    await page.reload();
    await expect(scene.getByText("Slide 1 of 8")).toBeVisible();
    await page.getByRole("button", { name: "Back to lessons" }).click();
    const card = page.getByTestId("lesson-card").filter({ hasText: "How plants make food" });
    await expect(card).toBeVisible();
    await expect(card.getByText("Done")).toBeVisible();

    page.once("dialog", (d) => d.accept());
    await card.getByRole("button", { name: "Delete How plants make food" }).click();
    await expect(page.getByText("No lessons yet.")).toBeVisible();
  });
});
