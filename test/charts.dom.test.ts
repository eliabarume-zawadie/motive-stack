/**
 * The chart helpers build inline SVG with no inline styles (the CSP forbids them), always with a text legend carrying the real
 * numbers, and never draw a made-up value. Loaded the same way the other DOM tests load the page's scripts.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const HTML = readFileSync("public/index.html", "utf8");
const SRC = readFileSync("public/charts.js", "utf8").replace(/^export /gm, "");

function page() {
  const dom = new JSDOM(HTML, { url: "http://localhost/", runScripts: "outside-only" });
  const w = dom.window as unknown as Window & Record<string, any>;
  w.eval(`${SRC}\nwindow.__c = { donut, stackedBars, sparkline };`);
  return { c: w.__c as Record<"donut" | "stackedBars" | "sparkline", (o: any) => HTMLElement>, doc: w.document };
}

describe("charts", () => {
  it("donut: arcs add up to the whole ring, the legend carries the numbers, and the chart has a name", () => {
    const { c } = page();
    const fig = c.donut({ label: "Lead sources", parts: [{ label: "Calls", value: 7 }, { label: "Forms", value: 3 }] });
    const arcs = [...fig.querySelectorAll("circle.ch-arc")];
    expect(arcs).toHaveLength(2);
    const lens = arcs.map((a) => Number(a.getAttribute("stroke-dasharray")!.split(" ")[0]));
    expect(lens[0] + lens[1]).toBeCloseTo(100, 1);
    expect(lens[0]).toBeCloseTo(70, 1);
    expect(fig.querySelector("svg")!.getAttribute("role")).toBe("img");
    expect(fig.querySelector("svg")!.getAttribute("aria-label")).toBe("Lead sources: Calls 7, Forms 3");
    expect([...fig.querySelectorAll(".ch-legend li")].map((li) => li.textContent)).toEqual(["Calls 7", "Forms 3"]);
    expect(fig.querySelector(".ch-text")!.textContent).toBe("10");
  });

  it("donut: no data draws only the empty track and a zero, never an invented slice; negative and non-numeric values count as 0", () => {
    const { c } = page();
    const fig = c.donut({ label: "Leads", parts: [{ label: "Calls", value: 0 }, { label: "Forms", value: -4 }, { label: "Other", value: Number.NaN }] });
    expect(fig.querySelectorAll("circle.ch-arc")).toHaveLength(0);
    expect(fig.querySelector(".ch-text")!.textContent).toBe("0");
  });

  it("stacked bars: heights share one scale, the legend totals each series, and the tallest bar fills the plot", () => {
    const { c } = page();
    const fig = c.stackedBars({ label: "Leads by week", names: ["Calls", "Forms"], categories: [{ label: "W1", values: [4, 4] }, { label: "W2", values: [2, 0] }] });
    const h = (el: Element) => (el.tagName === "rect" ? Number(el.getAttribute("height")) : 0);
    const rects = [...fig.querySelectorAll("rect.ch-bar")];
    expect(rects.length).toBeGreaterThan(0);
    expect(Math.max(...rects.map(h))).toBeLessThanOrEqual(25); // 4 of a max total of 8 over a 50 plot
    expect([...fig.querySelectorAll(".ch-legend li")].map((li) => li.textContent)).toEqual(["Calls 6", "Forms 4"]);
    expect(fig.querySelectorAll("text.ch-tick")).toHaveLength(2);
  });

  it("sparkline: needs two points to draw; one point says so instead of drawing a flat line", () => {
    const { c } = page();
    const some = c.sparkline({ label: "Leads per day", values: [1, 3, 2, 5] });
    expect(some.querySelector("polyline")!.getAttribute("points")!.split(" ")).toHaveLength(4);
    expect(some.querySelector(".ch-legend")!.textContent).toBe("Leads per day 5");
    const one = c.sparkline({ label: "Leads per day", values: [2] });
    expect(one.querySelector("polyline")).toBeNull();
    expect(one.querySelector(".ch-legend")!.textContent).toContain("not enough data yet");
  });

  it("never emits an inline style, script or link: the page's content policy would block them", () => {
    const { c } = page();
    const html = [
      c.donut({ label: "a", parts: [{ label: "x", value: 1 }] }),
      c.stackedBars({ label: "b", names: ["x"], categories: [{ label: "W1", values: [1] }] }),
      c.sparkline({ label: "c", values: [1, 2] }),
    ].map((f) => f.outerHTML).join("");
    expect(html).not.toMatch(/\sstyle\s*=|<script|href=|on[a-z]+\s*=/i);
  });
});
