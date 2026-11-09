import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LessonVisualSpec, VisualKind, VisualNode } from "../../lib/types";
import { withGlossary } from "./LessonPlayer";
import { formatValue, layoutTree, LessonVisual } from "./LessonVisual";

const node = (label: string, extra: Partial<VisualNode> = {}): VisualNode => ({ label, detail: `${label} detail`, value: 0, parent: -1, points: [], ...extra });

describe("layoutTree", () => {
  it("centres parents over their children and puts levels top to bottom", () => {
    const pos = layoutTree([node("Root"), node("A", { parent: 0 }), node("B", { parent: 0 }), node("A1", { parent: 1 })]);
    expect(pos.map((p) => p.parent)).toEqual([-1, 0, 0, 1]);
    expect(pos[0].levels).toBe(3);
    expect(pos[0].y).toBeLessThan(pos[1].y);
    expect(pos[1].y).toBeLessThan(pos[3].y);
    expect(pos[0].x).toBeCloseTo((pos[1].x + pos[2].x) / 2);
    expect(pos[3].x).toBeCloseTo(pos[1].x); // only child sits under its parent
  });

  it("treats forward or missing parents as extra roots (never loops)", () => {
    const pos = layoutTree([node("A", { parent: 1 }), node("B", { parent: 5 })]);
    expect(pos.every((p) => p.parent === -1 && Number.isFinite(p.x))).toBe(true);
  });
});

describe("formatValue", () => {
  it("formats numbers with units", () => {
    expect(formatValue(42.123, "%")).toBe("42.12%");
    expect(formatValue(1500, "km")).toBe("1,500 km");
    expect(formatValue(3, "")).toBe("3");
  });
});

describe("LessonVisual", () => {
  const kinds: VisualKind[] = ["flow", "cycle", "hierarchy", "compare", "timeline", "bars", "concept_map", "layers"];
  it.each(kinds)("draws a %s diagram whose parts can be selected", async (kind) => {
    const spec: LessonVisualSpec = {
      kind,
      caption: "c",
      unit: "%",
      nodes: [node("Alpha", { value: 10, points: ["p1"] }), node("Beta", { value: 30, parent: 0 }), node("Gamma", { value: 20, parent: 0 })],
    };
    const onSelect = vi.fn();
    render(<LessonVisual visual={spec} active={1} onSelect={onSelect} />);
    expect(screen.getByTestId("lesson-visual").dataset.kind).toBe(kind);
    for (const label of ["Alpha", "Beta", "Gamma"]) expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByRole("button", { pressed: true })).toHaveTextContent("Beta");
    await userEvent.click(screen.getByText("Gamma"));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("shows bar values with the unit", () => {
    render(<LessonVisual visual={{ kind: "bars", caption: "", unit: "%", nodes: [node("A", { value: 45 }), node("B", { value: 15 })] }} active={null} onSelect={() => {}} />);
    expect(screen.getByText("45%")).toBeInTheDocument();
    expect(screen.getByText("15%")).toBeInTheDocument();
  });
});

describe("withGlossary", () => {
  it("marks glossary terms (case-insensitive, longest first) with their definition", () => {
    render(<p>{withGlossary("Chlorophyll in a chloroplast absorbs light.", [
      { term: "chlorophyll", definition: "Green pigment." },
      { term: "Chloroplast", definition: "Where it happens." },
      { term: "a", definition: "too short" },
    ])}</p>);
    expect(screen.getByTitle("Green pigment.")).toHaveTextContent("Chlorophyll");
    expect(screen.getByTitle("Where it happens.")).toHaveTextContent("chloroplast");
    expect(screen.queryByTitle("too short")).toBeNull();
  });

  it("escapes regex characters in terms", () => {
    const out = withGlossary("Use C++ daily", [{ term: "C++", definition: "A language." }]);
    expect(out.length).toBeGreaterThan(0);
  });
});
