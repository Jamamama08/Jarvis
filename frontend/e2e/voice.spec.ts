import { expect, test, type Page } from "@playwright/test";

/**
 * Headless Chromium has no microphone or speakers, so these tests replace the
 * browser's Web Speech API with a scripted fake before the app loads. Everything
 * above that API (BrowserRecognizer/BrowserSynthesizer, useVoice, the chat UI,
 * the backend and the mock Claude API) is the real code.
 */
const USER = { username: "tony", name: "Tony", password: "arc-reactor-42" };

function installFakeSpeech({ recognition = true } = {}) {
  type Utt = { text: string; rate: number; voice: { name: string } | null; lang: string; onstart?: () => void; onend?: () => void; onerror?: () => void };
  const state = {
    utterances: [] as { text: string; rate: number; voice: string | null }[],
    pending: [] as Utt[],
    cancels: 0,
    recognizers: [] as unknown[],
    listening: false,
  };
  const voices = [
    { voiceURI: "fake-jarvis", name: "Fake Jarvis", lang: "en-GB", localService: true, default: true },
    { voiceURI: "fake-friday", name: "Fake Friday", lang: "en-US", localService: false, default: false },
  ];
  class FakeUtterance {
    text: string;
    rate = 1;
    lang = "";
    voice: { name: string } | null = null;
    onstart?: () => void;
    onend?: () => void;
    onerror?: () => void;
    constructor(text: string) {
      this.text = text;
    }
  }
  const synth = {
    speak(u: Utt) {
      state.utterances.push({ text: u.text, rate: u.rate, voice: u.voice?.name ?? null });
      state.pending.push(u);
      setTimeout(() => u.onstart?.(), 0);
    },
    cancel() {
      state.cancels++;
      state.pending = [];
    },
    getVoices: () => voices,
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  Object.defineProperty(window, "SpeechSynthesisUtterance", { value: FakeUtterance, configurable: true });

  class FakeRecognition {
    lang = "";
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    onend: (() => void) | null = null;
    start() {
      state.recognizers.push(this);
      state.listening = true;
    }
    stop() {
      state.listening = false;
      this.onend?.();
    }
    abort() {
      state.listening = false;
      this.onerror?.({ error: "aborted" });
      this.onend?.();
    }
  }
  delete (window as unknown as Record<string, unknown>).SpeechRecognition;
  Object.defineProperty(window, "webkitSpeechRecognition", { value: recognition ? FakeRecognition : undefined, configurable: true });

  const current = () => state.recognizers[state.recognizers.length - 1] as FakeRecognition;
  (window as unknown as Record<string, unknown>).__voice = {
    state,
    say(text: string, final: boolean) {
      const r = current();
      const res = Object.assign([{ transcript: text }], { isFinal: final });
      r.onresult?.({ resultIndex: 0, results: Object.assign([res], { length: 1 }) });
    },
    endRecognition() {
      state.listening = false;
      current().onend?.();
    },
    finishSpeech() {
      const all = state.pending;
      state.pending = [];
      all.forEach((u) => u.onend?.());
    },
    lang: () => current().lang,
  };
}

type VoiceHandle = {
  state: { utterances: { text: string; rate: number; voice: string | null }[]; cancels: number; recognizers: unknown[]; listening: boolean; pending: unknown[] };
};
const voiceState = (page: Page) => page.evaluate(() => (window as unknown as { __voice: VoiceHandle }).__voice.state);
const say = (page: Page, text: string, final: boolean) =>
  page.evaluate(([t, f]) => (window as unknown as { __voice: { say: (t: string, f: boolean) => void } }).__voice.say(t as string, f as boolean), [text, final] as const);
const endRecognition = (page: Page) => page.evaluate(() => (window as unknown as { __voice: { endRecognition: () => void } }).__voice.endRecognition());
const finishSpeech = (page: Page) => page.evaluate(() => (window as unknown as { __voice: { finishSpeech: () => void } }).__voice.finishSpeech());

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

async function saveVoiceSettings(page: Page, opts: { speak: boolean; conversation: boolean; autoSend?: boolean }) {
  await page.getByRole("button", { name: "Settings" }).click();
  const card = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Voice" }) });
  const toggle = async (label: string, on: boolean) => {
    if ((await card.getByLabel(label).isChecked()) !== on) await card.getByText(label, { exact: true }).click();
  };
  await toggle("Speak replies aloud", opts.speak);
  await toggle("Hands-free conversation", opts.conversation);
  await toggle("Send voice messages automatically", opts.autoSend ?? true);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(card.getByText("Saved")).toBeVisible();
  await page.getByRole("button", { name: "New conversation" }).click();
}

test.describe.serial("JARVIS phase 4: voice", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installFakeSpeech);
  });

  test("voice settings show support, voices and save preferences", async ({ page }) => {
    await login(page);
    await page.getByRole("button", { name: "Settings" }).click();
    const card = page.locator(".card").filter({ has: page.getByRole("heading", { name: "Voice" }) });
    await expect(card.getByTestId("voice-support")).toContainText("Voice input: supported");
    await expect(card.getByTestId("voice-support")).toContainText("2 voices available");
    await card.getByLabel("Voice", { exact: true }).selectOption("fake-jarvis");
    await card.getByLabel("Recognition language").selectOption("en-GB");
    if (!(await card.getByLabel("Speak replies aloud").isChecked())) await card.getByText("Speak replies aloud", { exact: true }).click();
    await expect(card.getByLabel("Speak replies aloud")).toBeChecked();
    await card.getByRole("button", { name: "Save" }).click();
    await expect(card.getByText("Saved")).toBeVisible();
    await card.getByRole("button", { name: "Test voice" }).click();
    const utt = (await voiceState(page)).utterances.at(-1)!;
    expect(utt.text).toContain("this is how I sound");
    expect(utt.voice).toBe("Fake Jarvis");
    await page.reload();
    await expect(card.getByLabel("Voice", { exact: true })).toHaveValue("fake-jarvis");
    await expect(card.getByLabel("Speak replies aloud")).toBeChecked();
  });

  test("speak a message, hear the reply as speech, and stop speaking", async ({ page }) => {
    await login(page);
    await page.getByTestId("mic-button").click();
    await expect(page.getByTestId("listening-banner")).toContainText("LISTENING (en-GB)");
    await say(page, "turn on the", false);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("turn on the");
    await say(page, "Turn on the lab lights.", true);
    await endRecognition(page);

    const list = page.getByTestId("message-list");
    await expect(list.locator('[data-role="user"]').first()).toContainText("Turn on the lab lights.");
    await expect(list.locator('[data-role="assistant"] pre code')).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop speaking" })).toBeVisible();
    const spoken = (await voiceState(page)).utterances.map((u) => u.text).join(" ");
    expect(spoken).toContain("Acknowledged. You said: Turn on the lab lights.");
    expect(spoken).toContain("(Code block omitted.)");
    expect(spoken).not.toMatch(/\*\*|```|print\(/);
    expect((await voiceState(page)).utterances.at(-1)!.voice).toBe("Fake Jarvis");

    await page.getByRole("button", { name: "Stop speaking" }).click();
    await expect(page.getByRole("button", { name: "Stop speaking" })).toBeHidden();
    expect((await voiceState(page)).cancels).toBeGreaterThan(0);
  });

  test("Esc cancels listening without sending; mute silences replies; read aloud works", async ({ page }) => {
    await login(page);
    await page.getByTestId("mic-button").click();
    await say(page, "never mind that", true);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("listening-banner")).toBeHidden();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
    await expect(page.getByTestId("message-list")).toHaveCount(0);

    await page.getByTestId("mute-toggle").click();
    await expect(page.getByTestId("mute-toggle")).toHaveAttribute("aria-pressed", "true");
    const before = (await voiceState(page)).utterances.length;
    await page.getByLabel("Message", { exact: true }).fill("Typed while muted");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("message-list").locator('[data-role="assistant"] pre code')).toBeVisible();
    expect((await voiceState(page)).utterances.length).toBe(before);

    const reply = page.getByTestId("message-list").locator('[data-role="assistant"]').last();
    await reply.hover();
    const count = (await voiceState(page)).utterances.length;
    await reply.getByRole("button", { name: "Read aloud" }).click();
    const readOut = (await voiceState(page)).utterances.slice(count).map((u) => u.text).join(" ");
    expect(readOut).toContain("You said: Typed while muted.");
    expect(readOut).toContain("(Code block omitted.)");
    // Mute persists across reloads on this device.
    await page.reload();
    await expect(page.getByTestId("mute-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  test("hands-free mode listens again after the reply is spoken", async ({ page }) => {
    await login(page);
    await saveVoiceSettings(page, { speak: true, conversation: true });
    await page.getByTestId("mic-button").click();
    await say(page, "What's on my calendar?", true);
    await endRecognition(page);
    await expect(page.getByTestId("message-list").locator('[data-role="assistant"] pre code')).toBeVisible();
    await expect(page.getByTestId("listening-banner")).toBeHidden(); // still speaking
    await finishSpeech(page);
    await expect(page.getByTestId("listening-banner")).toBeVisible();
    expect((await voiceState(page)).recognizers.length).toBe(2);
    await page.keyboard.press("Escape");
  });

  test("with auto-send off, the transcript lands in the message box for editing", async ({ page }) => {
    await login(page);
    await saveVoiceSettings(page, { speak: false, conversation: false, autoSend: false });
    await page.getByTestId("mic-button").click();
    await say(page, "Draft an email to Pepper", true);
    await endRecognition(page);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Draft an email to Pepper");
    await expect(page.getByTestId("message-list")).toHaveCount(0);
    await saveVoiceSettings(page, { speak: true, conversation: false, autoSend: true });
  });
});

test.describe("voice input unsupported", () => {
  test("mic explains why it's unavailable", async ({ page }) => {
    await page.addInitScript(installFakeSpeech, { recognition: false });
    await login(page);
    const mic = page.getByTestId("mic-button");
    await expect(mic).toHaveAttribute("aria-disabled", "true");
    await expect(mic).toHaveAttribute("title", /doesn't support speech recognition/);
    await mic.click({ force: true }); // aria-disabled: Playwright would otherwise wait for it to enable
    await expect(page.getByTestId("listening-banner")).toBeHidden();
  });
});
