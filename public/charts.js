// Small inline-SVG charts: donut, stacked bars and a sparkline. No library and no inline styles (the page's CSP forbids them):
// colours come from the .ch-s1..s5 classes in style.css, and every chart carries a text legend with the real numbers, so
// colour is never the only way to read it. Only counts and sums the caller passes in are drawn; nothing is estimated here.

/** The page's own SVG namespace, read from the icon sprite in index.html, so no URL literal is needed in this file. */
const svgNs = () => document.querySelector("svg.sprite").namespaceURI;
function svg(name, attrs = {}, ...kids) {
  const el = document.createElementNS(svgNs(), name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...kids);
  return el;
}
const amount = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const r2 = (v) => Math.round(v * 100) / 100;
const series = (i) => `ch-s${(i % 5) + 1}`;

/** A chart, its legend and an accessible name, wrapped in one figure. */
function figure(label, chart, legend) {
  const ul = document.createElement("ul");
  ul.className = "ch-legend";
  legend.forEach(({ text, value, cls }) => {
    const li = document.createElement("li");
    li.className = cls;
    const b = document.createElement("b");
    b.textContent = String(value);
    li.append(`${text} `, b);
    ul.append(li);
  });
  const fig = document.createElement("figure");
  fig.className = "chart-figure";
  chart.setAttribute("role", "img");
  chart.setAttribute("aria-label", `${label}: ${legend.map((l) => `${l.text} ${l.value}`).join(", ") || "no data"}`);
  fig.append(chart, ul);
  return fig;
}

/** parts: [{ label, value }]. The centre shows the total unless `center` is given. */
export function donut({ label, parts, center, caption = "" }) {
  const items = parts.map((p, i) => ({ text: p.label, value: amount(p.value), cls: series(i) }));
  const total = items.reduce((t, p) => t + p.value, 0);
  const chart = svg("svg", { class: "chart", viewBox: "0 0 40 40", width: 120, height: 120, focusable: "false" }, svg("circle", { class: "ch-track", cx: 20, cy: 20, r: 15.9155, "stroke-width": 4 }));
  let acc = 0;
  if (total > 0) {
    for (const p of items) {
      if (p.value <= 0) continue;
      const pct = (p.value / total) * 100;
      chart.append(svg("circle", { class: `ch-arc ${p.cls}`, cx: 20, cy: 20, r: 15.9155, "stroke-width": 4, "stroke-dasharray": `${r2(pct)} ${r2(100 - pct)}`, "stroke-dashoffset": r2(25 - acc) }));
      acc += pct;
    }
  }
  const t = svg("text", { class: "ch-text", x: 20, y: caption ? 21 : 22.5 });
  t.textContent = String(center ?? total);
  chart.append(t);
  if (caption) { const c = svg("text", { class: "ch-sub", x: 20, y: 26 }); c.textContent = caption; chart.append(c); }
  return figure(label, chart, items.map(({ text, value, cls }) => ({ text, value, cls })));
}

/** names: series names; categories: [{ label, values: [one number per series] }]. Bars share one scale. */
export function stackedBars({ label, names, categories }) {
  const step = 14, barW = 8, plotH = 50, base = 54;
  const totals = categories.map((c) => c.values.reduce((t, v) => t + amount(v), 0));
  const max = Math.max(0, ...totals);
  const chart = svg("svg", { class: "chart", viewBox: `0 0 ${categories.length * step + 4} 62`, width: Math.max(120, categories.length * 28), focusable: "false" }, svg("line", { class: "ch-axis", x1: 0, x2: categories.length * step + 4, y1: base, y2: base }));
  categories.forEach((c, ci) => {
    const x = 4 + ci * step;
    let y = base;
    const lastIdx = c.values.reduce((last, v, i) => (amount(v) > 0 ? i : last), -1);
    c.values.forEach((v, si) => {
      const h = max > 0 ? (amount(v) / max) * plotH : 0;
      if (h <= 0) return;
      y -= h;
      const cls = `ch-bar ${series(si)}`;
      chart.append(si === lastIdx && h >= 2
        ? svg("path", { class: cls, d: `M${r2(x)} ${r2(y + h)}V${r2(y + 2)}Q${r2(x)} ${r2(y)} ${r2(x + 2)} ${r2(y)}H${r2(x + barW - 2)}Q${r2(x + barW)} ${r2(y)} ${r2(x + barW)} ${r2(y + 2)}V${r2(y + h)}Z` })
        : svg("rect", { class: cls, x: r2(x), y: r2(y), width: barW, height: r2(h) }));
    });
    const tick = svg("text", { class: "ch-tick", x: r2(x + barW / 2), y: 60 });
    tick.textContent = c.label;
    chart.append(tick);
  });
  return figure(label, chart, names.map((text, si) => ({ text, value: categories.reduce((t, c) => t + amount(c.values[si]), 0), cls: series(si) })));
}

/** values: numbers in time order. Needs at least two to draw a line; says so in the legend otherwise. */
export function sparkline({ label, values, width = 100, height = 24 }) {
  const v = values.map(amount);
  const chart = svg("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, width, height, focusable: "false", preserveAspectRatio: "none" });
  if (v.length >= 2) {
    const max = Math.max(...v), min = Math.min(...v), span = max - min || 1, pad = 2;
    const pts = v.map((n, i) => `${r2((i / (v.length - 1)) * width)},${r2(height - pad - ((n - min) / span) * (height - pad * 2))}`);
    chart.append(svg("polygon", { class: "ch-area ch-s1", points: `0,${height} ${pts.join(" ")} ${width},${height}` }), svg("polyline", { class: "ch-line ch-s1", points: pts.join(" "), "stroke-width": 2, "vector-effect": "non-scaling-stroke" }));
  }
  return figure(label, chart, [{ text: label, value: v.length >= 2 ? v[v.length - 1] : "not enough data yet", cls: "ch-s1" }]);
}
