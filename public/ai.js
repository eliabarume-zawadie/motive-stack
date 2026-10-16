// AI settings, model list, usage and connection test. Uses textContent only (via h()).
// The browser only ever sees mode flags and usage metadata: never provider keys, prompts or responses.

export function initAi({ $, h, api, state, session, pill, simBadge, showError }) {
  const key = (p, m) => `${p}|${m}`;
  const unkey = (k) => { const i = k.indexOf("|"); return { provider: k.slice(0, i), model: k.slice(i + 1) }; };
  const ai = { models: [], settings: null };
  const money = (micros, cur) => (micros == null ? "unknown" : `${(micros / 1e6).toFixed(micros < 1e4 ? 4 : 2)} ${cur}`);

  function modelOptions(select, { onlyEligible = false, blank = null } = {}) {
    const opts = [];
    if (blank) opts.push(h("option", { value: "" }, blank));
    for (const m of ai.models) {
      if (onlyEligible && !m.eligible) continue;
      opts.push(h("option", { value: key(m.provider, m.model), disabled: !m.eligible }, m.eligible ? m.label : `${m.label} (unavailable: ${m.reason})`));
    }
    select.replaceChildren(...opts);
  }

  function applyRoutingVisibility() {
    const mode = $("ai-form").elements.routingMode.value;
    $("ai-primary-wrap").hidden = mode === "automatic";
    $("ai-fallback-wrap").hidden = mode !== "preferred_with_fallback";
  }

  function renderBanner() {
    const live = !!state.config?.ai?.live;
    const local = !!state.config?.ai?.local;
    $("ai-mode").textContent = live
      ? "AI is in LIVE mode: real provider calls are enabled on the server and may be billed. Keys stay server-side."
      : local
        ? "AI is in LOCAL mode: a model server on this computer (Ollama) answers. Real model output, no key, no charge, and nothing leaves this machine. It is slow on a CPU and not guaranteed to follow the schema, so every result is validated."
        : "AI is in MOCK mode: a deterministic offline model answers. Results are simulated, cost is not applicable, and no provider is contacted.";
    $("ai-test-btn").textContent = live ? "Test connection (one real, possibly billed request)" : local ? "Test local model (one real request, free; can take up to a minute)" : "Run simulated test (no real connection)";
  }

  function fillForm() {
    const f = $("ai-form").elements, s = ai.settings;
    modelOptions(f.primary);
    modelOptions(f.fallback, { blank: "No fallback" });
    f.routingMode.value = s.routingMode;
    if (s.provider) f.primary.value = key(s.provider, s.model);
    f.fallback.value = s.fallbackProvider ? key(s.fallbackProvider, s.fallbackModel) : "";
    f.maxRequestsPerDay.value = s.maxRequestsPerDay ?? "";
    f.monthlyBudget.value = s.monthlyBudgetMicros ? String(s.monthlyBudgetMicros / 1e6) : "";
    $("ai-currency").textContent = state.config?.ai?.currency ?? "USD";
    const providers = [...new Set(ai.models.map((m) => m.provider))];
    $("ai-allowed-boxes").replaceChildren(...providers.map((p) =>
      h("label", { class: "chk" }, h("input", { type: "checkbox", name: "allow", value: p, checked: !s.allowedProviders || s.allowedProviders.includes(p) }), p)));
    applyRoutingVisibility();
    const gen = $("gen-model").value;
    modelOptions($("gen-model"), { onlyEligible: true, blank: "Use workspace AI settings" });
    if ([...$("gen-model").options].some((o) => o.value === gen)) $("gen-model").value = gen;
    modelOptions($("ai-test-model"), { onlyEligible: true });
    renderBanner();
  }

  function renderModelTable() {
    $("ai-models").replaceChildren(h("table", {},
      h("thead", {}, h("tr", {}, ...["Model", "Cost tier", "Price configured", "Status"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ai.models.map((m) => h("tr", {},
        h("td", {}, m.label, " ", m.simulated ? simBadge() : null),
        h("td", {}, m.costTier),
        h("td", {}, m.simulated ? "n/a" : m.local ? "no charge (runs locally)" : m.priced ? "yes" : "no (cost shown as unknown)"),
        h("td", {}, m.eligible ? pill("usable", "ok") : pill("unavailable", "warn"), m.eligible ? "" : ` ${m.reason}`))))));
  }

  function renderUsage(u) {
    const cur = u.summary.currency, t = u.summary.today, mo = u.summary.thisMonth;
    // Never present an incomplete total as if it were the whole cost: unknown stays unknown.
    const unknown = mo.requestsWithUnknownCost;
    const spend = mo.liveRequests === 0
      ? "no live requests"
      : unknown === 0
        ? money(mo.knownCostMicros, cur) + " estimated"
        : mo.knownCostMicros > 0
          ? "at least " + money(mo.knownCostMicros, cur) + " (" + unknown + " request(s) have unknown cost, so this total is incomplete)"
          : "unknown (" + unknown + " live request(s) have no priced cost yet)";
    const head = h("p", { class: "hint" }, "Today: " + t.simulatedRequests + " simulated, " + (t.localRequests || 0) + " local (no charge), " + t.liveRequests + " live request(s). This month, live spend: " + spend + ".");
    const rows = u.recent.map((r) => h("tr", {},
      h("td", {}, r.startedAt.replace("T", " ").slice(0, 19)),
      h("td", {}, r.taskType, " ", r.simulated ? simBadge() : r.mode === "local" ? pill("LOCAL", "ok") : pill("LIVE", "warn")),
      h("td", {}, `${r.provider}/${r.model}`, r.fallbackFrom ? ` (fallback from ${r.fallbackFrom})` : ""),
      h("td", {}, `${r.attemptKind}: `, pill(r.outcome, r.outcome === "ok" ? "ok" : "bad")),
      h("td", {}, r.inputTokens == null ? "unknown" : `${r.inputTokens} in / ${r.outputTokens ?? "unknown"} out`, r.usageSource === "simulated" ? " (simulated)" : ""),
      h("td", {}, r.simulated ? "n/a (simulated)" : r.costStatus === "local_no_charge" ? "no charge (local)" : money(r.estimatedCostMicros, r.currency || cur) + (r.estimatedCostMicros == null ? ` (${r.costStatus.replace(/_/g, " ")})` : "")),
      h("td", {}, r.latencyMs == null ? "-" : `${r.latencyMs} ms`)));
    $("ai-usage").replaceChildren(head, rows.length
      ? h("table", {}, h("thead", {}, h("tr", {}, ...["Time", "Task", "Model", "Attempt", "Tokens", "Est. cost", "Latency"].map((x) => h("th", {}, x)))), h("tbody", {}, rows))
      : h("p", { class: "hint" }, "No AI requests yet."));
  }

  /** Reload settings, models and usage. The form is only re-filled on request so typing is never clobbered. */
  async function load({ refillForm = false } = {}) {
    if (!session()) return;
    const [st, us] = await Promise.all([api("/ai/settings", { quiet: true }), api("/ai/usage", { quiet: true })]);
    ai.models = st.models;
    ai.settings = st.settings;
    renderModelTable();
    renderUsage(us);
    if (refillForm) fillForm();
  }

  /** Body for POST /campaigns/generate: an explicit choice, or {} to use the workspace AI settings. */
  function generateBody() {
    const v = $("gen-model").value;
    if (!v) return {};
    const { provider, model } = unkey(v);
    return { providerId: provider, model };
  }

  $("ai-form").elements.routingMode.addEventListener("change", applyRoutingVisibility);

  $("ai-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target.elements, mode = f.routingMode.value;
    const boxes = [...document.querySelectorAll("#ai-allowed-boxes input")];
    const allow = boxes.filter((x) => x.checked).map((x) => x.value);
    const body = {
      routingMode: mode,
      maxRequestsPerDay: f.maxRequestsPerDay.value ? Number(f.maxRequestsPerDay.value) : null,
      monthlyBudgetMicros: f.monthlyBudget.value ? Math.round(Number(f.monthlyBudget.value) * 1e6) : null,
      allowedProviders: allow.length && allow.length < boxes.length ? allow : null,
    };
    if (mode !== "automatic") { const p = unkey(f.primary.value); body.provider = p.provider; body.model = p.model; }
    if (mode === "preferred_with_fallback" && f.fallback.value) { const fb = unkey(f.fallback.value); body.fallbackProvider = fb.provider; body.fallbackModel = fb.model; }
    try {
      const r = await api("/ai/settings", { method: "PUT", body });
      ai.models = r.models; ai.settings = r.settings;
      fillForm(); renderModelTable();
      $("ai-saved").textContent = "Saved";
    } catch { $("ai-saved").textContent = ""; }
  });

  $("ai-test-btn").addEventListener("click", async () => {
    const v = $("ai-test-model").value;
    if (!v) return;
    const live = !!state.config?.ai?.live;
    if (live && !confirm("This makes one real request to the provider and may be billed. Continue?")) return;
    const out = $("ai-test-result");
    out.textContent = "Testing...";
    try {
      const { provider, model } = unkey(v);
      const r = await api("/ai/connection-test", { method: "POST", body: { provider, model } });
      out.textContent = r.simulated
        ? `SIMULATED: ${r.message}`
        : r.connected
          ? `Connected${state.config?.ai?.local ? " to the local model server" : ""} (real request): ${r.model}, ${r.latencyMs} ms, request id ${r.requestId || "n/a"}`
          : `NOT connected: ${r.message} (${r.errorKind})`;
      await load();
    } catch (e) { out.textContent = `Test could not run: ${e.message}`; }
  });

  return { load, generateBody, renderBanner };
}
