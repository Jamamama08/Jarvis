import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolActivity } from "./ToolActivity";
import { upsertTool } from "../views/ChatView";
import { api } from "../lib/api";
import type { ToolExecution } from "../lib/types";

const base: ToolExecution = {
  id: "ex1", conversation_id: "c", message_id: "m", tool_use_id: "toolu_1", tool_name: "write_file",
  permission_level: "restricted", status: "pending_approval", summary: "create notes.md (5 chars)",
  input: { path: "notes.md", content: "hello", mode: "create", _summary: "x" }, output: null, error: null,
  duration_ms: null, created_at: "2026-11-06T12:00:00Z", finished_at: null,
};

describe("ToolActivity", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks for approval with the call's input and sends the decision", async () => {
    const decide = vi.spyOn(api, "decideTool").mockResolvedValue(undefined);
    render(<ToolActivity tools={[base]} />);
    expect(screen.getByText("Needs your approval")).toBeInTheDocument();
    expect(screen.getByTestId("tool-input")).toHaveTextContent("path:notes.md");
    expect(screen.getByTestId("tool-input")).not.toHaveTextContent("_summary");
    await userEvent.click(screen.getByLabelText(/Always allow write file/));
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(decide).toHaveBeenCalledWith("ex1", true, true);
  });

  it("sensitive actions can be denied but not set to always allow", async () => {
    const decide = vi.spyOn(api, "decideTool").mockResolvedValue(undefined);
    render(<ToolActivity tools={[{ ...base, tool_name: "delete_file", permission_level: "sensitive" }]} />);
    expect(screen.getByText(/sensitive action/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Always allow/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(decide).toHaveBeenCalledWith("ex1", false, false);
  });

  it("shows results that expand to the output", async () => {
    render(<ToolActivity tools={[{ ...base, tool_name: "calculator", status: "succeeded", summary: "2+2", output: "2+2 = 4", duration_ms: 3 }]} />);
    expect(screen.getByText("Calculator")).toBeInTheDocument();
    expect(screen.getByText(/Done · 3 ms/)).toBeInTheDocument();
    expect(screen.queryByText("2+2 = 4")).toBeNull();
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("2+2 = 4")).toBeInTheDocument();
  });
});

describe("upsertTool", () => {
  it("replaces a streaming placeholder by tool_use_id, then updates by id", () => {
    const placeholder = { ...base, id: "start-toolu_1", status: "preparing" as const };
    let list = upsertTool([], placeholder);
    list = upsertTool(list, { ...base, status: "pending_approval" });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("ex1");
    list = upsertTool(list, { ...base, status: "succeeded" });
    expect(list.map((t) => t.status)).toEqual(["succeeded"]);
    list = upsertTool(list, { ...base, id: "ex2", tool_use_id: "toolu_2" });
    expect(list).toHaveLength(2);
  });
});
