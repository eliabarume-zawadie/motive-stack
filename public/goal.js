// Step 3: the owner's marketing goal. The choice is sent with "Create my campaign draft" and saved with the draft (the server checks it again).
// "Promote one service" needs a service; the choices come from the services in the Business Brain form. Built with textContent only (via h()).

export function initGoal({ $, h }) {
  const goal = () => document.querySelector("input[name=goal]:checked")?.value || "lead_generation";

  function services() {
    const f = $("brain-form")?.elements;
    return String(f?.services?.value || "").split("\n").map((x) => x.trim()).filter(Boolean);
  }

  function refresh() {
    const wrap = $("goal-service-wrap"), sel = $("goal-service");
    const need = goal() === "promote_service";
    wrap.hidden = !need;
    if (!need) return;
    const keep = sel.value, list = services();
    sel.replaceChildren(...(list.length ? list.map((s) => h("option", { value: s }, s)) : [h("option", { value: "" }, "Add services in My business first")]));
    if (list.includes(keep)) sel.value = keep;
  }

  /** The plan fields for POST /campaigns/generate. A plain lead goal with no extras sends nothing extra. */
  function body() {
    const g = goal(), out = {};
    const days = Number($("goal-days").value);
    if (g !== "lead_generation") out.goal = g;
    if (g === "promote_service" && $("goal-service").value) out.focusService = $("goal-service").value;
    if (days) { out.durationDays = days; out.goal = g; }
    return out;
  }

  for (const r of document.querySelectorAll("input[name=goal]")) r.addEventListener("change", refresh);
  $("gen-form").addEventListener("focusin", refresh);
  return { body, refresh };
}
