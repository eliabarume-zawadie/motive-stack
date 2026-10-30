// "What your ads may say": every strength, credential and price in the Business Brain form, in one place, each with a Remove button. Ads may only repeat
// what is listed here, and each line is something the owner confirms is true. Built with textContent only (via h()).

const CL_GROUPS = [
  { field: "differentiators", title: "Strengths ads may use", split: "\n" },
  { field: "verifiedFacts", title: "Credentials and facts ads may use", split: "\n" },
  { field: "approvedPricing", title: "Prices and payment statements ads may use", split: ";" },
];
/** Wording that compares or promises something: it needs proof before an ad repeats it. */
const CL_NEEDS_PROOF = /\b(?:better|faster|stronger|superior|proven|best|lowest|cheapest|guarantee\w*|award\w*|#\s?1|number one|\d+\s?%|\d+\s?years?)\b/i;

export function initClaimsReview({ $, h, pill }) {
  const form = () => $("brain-form").elements;
  const itemsOf = (g) => String(form()[g.field].value || "").split(g.split).map((x) => x.trim()).filter(Boolean);

  function remove(g, item) {
    const el = form()[g.field];
    const kept = itemsOf(g).filter((x) => x !== item);
    el.value = kept.join(g.split === ";" ? "; " : "\n");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    render();
    $("brain-version").textContent = "You removed a line: press Save Business Brain to keep the change.";
  }

  function render() {
    const root = $("claims-review");
    const groups = CL_GROUPS.map((g) => ({ g, items: itemsOf(g) })).filter((x) => x.items.length);
    const unverified = String(form().unverifiedClaims.value || "").split("\n").map((x) => x.trim()).filter(Boolean);
    const flagged = groups.reduce((n, { items }) => n + items.filter((x) => CL_NEEDS_PROOF.test(x)).length, 0);
    root.classList.toggle("has-flags", flagged > 0);
    root.replaceChildren(...[
      flagged ? h("div", { class: "claims-alert" }, h("strong", {}, `Needs your confirmation (${flagged} ${flagged === 1 ? "item" : "items"})`), " ", pill("Action required", "warn"),
        h("p", { class: "hint" }, "These lines compare or promise something. Keep one only if you could show proof for it; otherwise remove it.")) : null,
      h("h4", {}, "What your ads may say"),
      h("p", { class: "hint" }, "Ads may only repeat what is listed here, and each line is something you confirm is true and could prove. Remove anything you are not sure about."),
      ...(groups.length
        ? groups.map(({ g, items }) => h("div", { class: "claims-group" }, h("strong", {}, g.title),
          h("ul", { class: "plain" }, items.map((item) => h("li", { class: CL_NEEDS_PROOF.test(item) ? "claim-row needs" : "claim-row" },
            h("span", {}, item, CL_NEEDS_PROOF.test(item) ? [" ", pill("sounds like a claim that needs proof", "warn")] : null),
            h("button", { type: "button", class: "secondary small", "aria-label": `Remove: ${item}`, onclick: () => remove(g, item) }, "Remove"))))))
        : [h("p", { class: "hint" }, "Nothing yet. Until you add some, ads will only use your offer and the basics of your business.")]),
      unverified.length
        ? h("div", { class: "claims-group" }, h("strong", {}, "Kept out of ads (not verified)"),
          h("ul", { class: "plain" }, unverified.map((item) => h("li", { class: "muted" }, item))),
          h("p", { class: "hint" }, "These stay out of ads until you can prove them."))
        : null,
    ].filter(Boolean));
  }

  $("brain-form").addEventListener("input", render);
  return { render };
}
