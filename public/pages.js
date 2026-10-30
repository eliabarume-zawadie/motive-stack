// Pages: every item in the side list is its own page. Exactly one <section> of <main> is shown at a time, and the address fragment (#s-...) says
// which, so the back button, a refresh and a copied link all land on the right page. Only a section id is ever read from or written to the address.
// Built with textContent only.

const HOME = "s-dashboard";
const GROUP_OF = { "s-new-campaign": "Create" }; // pages reached from a button rather than a place in the list

let showPage = null; // set by initPages; revealEl uses it to switch pages without waiting for the address change

/** Makes `el` visible: switches to the page that holds it, then scrolls it into view. Safe to call for an element that is not on any page. */
export function revealEl(el, block = "start") {
  if (!el) return;
  const page = el.closest("main > section");
  if (page && page.hidden) {
    if (showPage) showPage(page.id, false);
    else page.hidden = false;
    if (location.hash !== `#${page.id}`) location.hash = page.id;
  }
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: "smooth", block });
}

export function initPages() {
  const nav = document.getElementById("main-nav");
  const links = [...nav.querySelectorAll("a")];
  const pages = new Map([...document.querySelectorAll("main > section")].map((s) => [s.id, s]));
  const info = new Map(); // page id -> { group, label }, read from the side list so the names are written once
  let group = "";
  for (const el of nav.children) {
    if (el.classList.contains("nav-group")) group = el.textContent.trim();
    else if (el.tagName === "A") info.set(el.getAttribute("href").slice(1), { group, label: el.querySelector("span").textContent.trim() });
  }

  // a breadcrumb above each page's title, and a title that can take focus when the page changes (so a screen reader announces the new page)
  for (const [id, page] of pages) {
    const i = info.get(id);
    if (!i) continue;
    const crumbs = document.createElement("nav");
    crumbs.className = "crumbs";
    crumbs.setAttribute("aria-label", "Breadcrumb");
    const mk = (text, cur) => { const s = document.createElement("span"); s.textContent = text; if (cur) s.setAttribute("aria-current", "page"); return s; };
    crumbs.append(mk(GROUP_OF[id] || i.group), mk("›"), mk(i.label, true));
    crumbs.children[1].setAttribute("aria-hidden", "true");
    page.prepend(crumbs);
    const title = page.querySelector("h2");
    if (title) title.tabIndex = -1;
  }

  let current = null;
  function show(id, focus) {
    if (!pages.has(id)) return;
    for (const [pid, page] of pages) page.hidden = pid !== id;
    for (const a of links) a.setAttribute("aria-current", a.getAttribute("href") === `#${id}` ? "true" : "false");
    if (id === current) return;
    current = id;
    const i = info.get(id);
    if (i) document.title = `${i.label} - MotiveStack`;
    if (focus) {
      const top = () => { document.documentElement.scrollTop = 0; };
      top();
      setTimeout(top, 0); // the browser's own jump to the clicked link's target runs after this handler: a page always opens at its top
      pages.get(id).querySelector("h2")?.focus({ preventScroll: true });
    }
  }
  showPage = show;

  const fromAddress = () => { const id = location.hash.slice(1); return pages.has(id) ? id : null; };
  for (const a of links) a.addEventListener("click", () => show(a.getAttribute("href").slice(1), true));
  window.addEventListener("hashchange", () => { const id = fromAddress(); if (id && id !== current) show(id, true); });
  show(fromAddress() || HOME, false);
}
