// Developer mode: is AI set up, what is the server-side spending ceiling, and one short test request. The browser never sees a key: the server
// only reports whether one is present (yes/no). The result always says whether it came from the simulator or from a real provider.

export function initAiTest({ $, h, api, once, pill, simBadge }) {
  const money = (micros, cur) => (micros == null ? "unknown" : `${(micros / 1e6).toFixed(4)} ${cur}`);

  function renderStatus(s) {
    const root = $("aitest-status");
    const modePill = s.mode === "mock" ? simBadge() : s.mode === "local" ? pill("LOCAL", "ok") : pill("LIVE (billable)", "warn");
    const keyRows = s.providers.filter((p) => p.keyConfigured !== null).map((p) => h("li", {}, `${p.label}: `, p.keyConfigured ? pill("key present on the server", "ok") : pill("no key set on the server", ""), p.keyConfigured && s.mode === "mock" ? h("span", { class: "muted" }, " (ignored in mock mode)") : null));
    const b = s.budget;
    root.replaceChildren(
      h("p", {}, "AI mode: ", modePill, " ", h("span", { class: "muted" }, s.mode === "mock" ? "Nothing is sent to any provider and nothing is charged." : s.mode === "local" ? "A model on this computer answers; nothing is billed." : "Requests go to the provider and may be billed.")),
      h("ul", { class: "plain" }, keyRows),
      s.mode === "live"
        ? h("p", {}, b.configured ? `Server spending ceiling this month: ${money(b.ceilingMicros, b.currency)}. Used (estimated): ${money(b.spentMicros, b.currency)}. Left: ${money(b.remainingMicros, b.currency)}. Live requests today: ${b.requestsToday}${b.maxRequestsPerDay ? ` of ${b.maxRequestsPerDay}` : ""}.` : "No spending ceiling is set on the server, so every live request will be refused.")
        : h("p", { class: "hint" }, "The spending ceiling only applies to live (paid) requests."),
      s.mode === "live" && b.requestsWithUnknownCost ? h("p", { class: "flag-note" }, `${b.requestsWithUnknownCost} earlier live request(s) returned no token count, so spending cannot be verified and live requests are paused.`) : null,
      h("p", { class: "hint" }, b.note),
      h("p", {}, h("strong", {}, "Next step: "), s.nextStep),
    );
  }

  function renderResult(r) {
    const root = $("aitest-result");
    const where = r.mode === "mock" ? [simBadge(), " Simulated: no provider was contacted."] : r.mode === "local" ? [pill("LOCAL", "ok"), " Answered by a model on this computer."] : [pill("LIVE", "warn"), " Answered by the real provider."];
    const u = r.usage;
    root.replaceChildren(h("div", { class: "card" },
      h("p", {}, where),
      h("p", {}, "Status: ", r.status === "ok" ? pill("ok", "ok") : pill("error", "bad"), ` ${r.provider}/${r.model}`),
      r.status === "ok" ? h("blockquote", { class: "answer" }, r.text || "(empty answer)") : h("p", { class: "flag-note" }, `${r.errorKind}: ${r.message}`),
      h("p", { class: "hint" },
        u ? `Tokens: ${u.inputTokens ?? "unknown"} in, ${u.outputTokens ?? "unknown"} out (${u.source === "provider" ? "reported by the provider" : "simulated, not a real measurement"}). ` : "Token usage was not reported. ",
        r.mode === "mock" ? "Cost: n/a (simulated)." : r.estimatedCostMicros == null ? "Cost: unknown (not shown as 0)." : `Cost: about ${money(r.estimatedCostMicros, r.currency)}, estimated from the provider's token counts and our price list (not a bill).`,
        r.latencyMs != null ? ` Took ${r.latencyMs} ms.` : "", r.requestId ? ` Request id: ${r.requestId}.` : ""),
    ));
  }

  async function load() {
    try {
      const [s, models] = await Promise.all([api("/ai/status", { quiet: true }), api("/ai/settings", { quiet: true })]);
      renderStatus(s);
      const usable = models.models.filter((m) => m.eligible);
      const sel = $("aitest-model");
      const prev = sel.value;
      sel.replaceChildren(...(usable.length ? usable.map((m) => h("option", { value: `${m.provider}/${m.model}` }, `${m.label}${m.simulated ? " (simulated)" : ""}`)) : [h("option", { value: "" }, "No model is available in this mode")]));
      if (prev && usable.some((m) => `${m.provider}/${m.model}` === prev)) sel.value = prev;
      $("aitest-send").disabled = usable.length === 0 || $("aitest-send").dataset.denied === "1";
      $("aitest-why").textContent = usable.length ? "" : (models.models.find((m) => m.provider === "openai")?.reason || "");
    } catch { /* no workspace selected, or no access */ }
  }

  $("aitest-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const chosen = String($("aitest-model").value);
    const slash = chosen.indexOf("/");
    const provider = chosen.slice(0, slash), model = chosen.slice(slash + 1);
    if (slash < 1 || !model) return;
    await once("aitest", [$("aitest-send")], async () => {
      $("aitest-error").textContent = "";
      try {
        const r = await api("/ai/test-request", { method: "POST", body: { provider, model, prompt: $("aitest-prompt").value }, quiet: true });
        renderResult(r);
        await load();
      } catch (err) { $("aitest-error").textContent = err.message; }
    });
  });

  return { load };
}
