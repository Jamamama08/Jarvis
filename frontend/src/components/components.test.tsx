import { render, screen } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import type { Message } from "../lib/types";

const base: Message = {
  id: "1", seq: 1, role: "assistant", content: "Hello sir", status: "complete",
  model: "claude-x", error: null, created_at: "2026-11-06T12:00:00Z", memory_ids: [],
};

function ComposerHarness(props: Omit<ComponentProps<typeof Composer>, "draft" | "onDraftChange">) {
  const [draft, setDraft] = useState("");
  return <Composer {...props} draft={draft} onDraftChange={setDraft} />;
}

describe("Composer", () => {
  it("sends on Enter, newline on Shift+Enter, and ignores blank input", async () => {
    const onSend = vi.fn();
    render(<ComposerHarness onSend={onSend} onStop={() => {}} streaming={false} sendOnEnter assistantName="JARVIS" />);
    const box = screen.getByLabelText("Message");
    await userEvent.type(box, "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.clear(box);
    await userEvent.type(box, "line one{Shift>}{Enter}{/Shift}line two{Enter}");
    expect(onSend).toHaveBeenCalledWith("line one\nline two");
    expect(box).toHaveValue("");
  });

  it("shows a stop button while streaming", async () => {
    const onStop = vi.fn();
    render(<ComposerHarness onSend={() => {}} onStop={onStop} streaming sendOnEnter assistantName="JARVIS" />);
    expect(screen.queryByLabelText("Send message")).toBeNull();
    await userEvent.click(screen.getByLabelText("Stop response"));
    expect(onStop).toHaveBeenCalled();
  });

  it("mic button toggles listening, shows the live transcript and explains when unavailable", async () => {
    const onToggle = vi.fn();
    const voice = { available: true, unavailableReason: null, listening: false, transcript: "", onToggle };
    const { rerender } = render(<ComposerHarness onSend={() => {}} onStop={() => {}} streaming={false} sendOnEnter assistantName="JARVIS" voice={voice} />);
    await userEvent.click(screen.getByTestId("mic-button"));
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(<ComposerHarness onSend={() => {}} onStop={() => {}} streaming={false} sendOnEnter assistantName="JARVIS" voice={{ ...voice, listening: true, transcript: "open the garage" }} />);
    expect(screen.getByLabelText("Message")).toHaveValue("open the garage");
    expect(screen.getByLabelText("Message")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Send message")).toBeDisabled();
    rerender(<ComposerHarness onSend={() => {}} onStop={() => {}} streaming={false} sendOnEnter assistantName="JARVIS" voice={{ ...voice, available: false, unavailableReason: "No speech here" }} />);
    const mic = screen.getByTestId("mic-button");
    expect(mic).toHaveAttribute("aria-disabled", "true");
    expect(mic).toHaveAttribute("title", "No speech here");
    await userEvent.click(mic);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

describe("MessageBubble", () => {
  it("shows how many memories were sent with a user message", () => {
    const { rerender } = render(<MessageBubble message={{ ...base, role: "user", content: "hi", memory_ids: ["a", "b"] }} assistantName="JARVIS" />);
    expect(screen.getByTestId("memories-used")).toHaveTextContent("2 memories used");
    rerender(<MessageBubble message={{ ...base, role: "user", content: "hi", memory_ids: [] }} assistantName="JARVIS" />);
    expect(screen.queryByTestId("memories-used")).toBeNull();
  });

  it("renders roles and states", () => {
    const { rerender, container } = render(<MessageBubble message={{ ...base, role: "user", content: "hi" }} assistantName="JARVIS" />);
    expect(container.querySelector('[data-role="user"]')).toHaveTextContent("hi");
    rerender(<MessageBubble message={base} assistantName="JARVIS" />);
    expect(screen.getByText("JARVIS")).toBeInTheDocument();
    expect(screen.getByText("Hello sir")).toBeInTheDocument();
    rerender(<MessageBubble message={{ ...base, status: "error", error: "boom" }} assistantName="JARVIS" />);
    expect(screen.getByText("boom")).toBeInTheDocument();
    rerender(<MessageBubble message={{ ...base, status: "cancelled" }} assistantName="JARVIS" />);
    expect(screen.getByText("Response stopped")).toBeInTheDocument();
    rerender(<MessageBubble message={{ ...base, role: "system", content: "notice" }} assistantName="JARVIS" />);
    expect(container.querySelector('[data-role="system"]')).toHaveTextContent("notice");
  });
});
