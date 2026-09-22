import { describe, expect, it } from "vitest";
import { legendGradient } from "./ui";

describe("legendGradient", () => {
  it("builds a linear-gradient with stops flipped top-to-bottom", () => {
    const css = legendGradient([
      { t: 0, color: "#000000" },
      { t: 1, color: "#ffffff" },
    ]);
    expect(css).toBe("linear-gradient(to top, #000000 0%, #ffffff 100%)");
  });

  it("preserves stop order and computes intermediate percentages", () => {
    const css = legendGradient([
      { t: 0, color: "#111111" },
      { t: 0.5, color: "#222222" },
      { t: 1, color: "#333333" },
    ]);
    expect(css).toBe(
      "linear-gradient(to top, #111111 0%, #222222 50%, #333333 100%)",
    );
  });

  it("returns an empty gradient list for no stops", () => {
    expect(legendGradient([])).toBe("linear-gradient(to top, )");
  });
});

