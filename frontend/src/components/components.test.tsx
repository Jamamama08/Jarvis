import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";
import type { Message } from "../lib/types";

const base: Message = {
  id: "1", seq: 1, role: "assistant", content: "Hello sir", status: "complete",
  model: "claude-x", error: null, created_at: "2026-11-06T12:00:00Z",
};

describe("Composer", () => {
  it("sends on Enter, newline on Shift+Enter, and ignores blank input", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} onStop={() => {}} streaming={false} sendOnEnter assistantName="JARVIS" />);
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
    render(<Composer onSend={() => {}} onStop={onStop} streaming sendOnEnter assistantName="JARVIS" />);
    expect(screen.queryByLabelText("Send message")).toBeNull();
    await userEvent.click(screen.getByLabelText("Stop response"));
    expect(onStop).toHaveBeenCalled();
  });

  it("keeps the microphone disabled until voice lands", () => {
    render(<Composer onSend={() => {}} onStop={() => {}} streaming={false} sendOnEnter assistantName="JARVIS" />);
    expect(screen.getByLabelText(/Voice input/)).toBeDisabled();
  });
});

describe("MessageBubble", () => {
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
