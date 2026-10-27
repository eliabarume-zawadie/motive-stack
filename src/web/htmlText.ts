/**
 * Turns an HTML page into readable text, the page's links, and a few facts about it. No HTML is ever executed or rendered and no
 * script content is kept. One linear scan (no backtracking patterns), so a hostile page cannot make it slow.
 */

export interface PageLink { href: string; text: string }
export interface ExtractedPage {
  title: string;
  /** og:site_name / application-name, when the page declares one. */
  siteName: string;
  description: string;
  /** Lower-cased content of <meta name="robots">, or "". */
  robotsMeta: string;
  text: string;
  links: PageLink[];
}

const SKIP = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "embed", "canvas", "head"]);
const BLOCK = new Set(["p", "div", "br", "li", "ul", "ol", "tr", "table", "section", "article", "header", "footer", "main", "aside", "nav", "form", "blockquote", "dd", "dt", "dl", "address", "figure", "figcaption", "details", "summary", "hr", "h1", "h2", "h3", "h4", "h5", "h6"]);
const HEADING = new Set(["h1", "h2", "h3"]);
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : " ";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-z_:][-a-z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(tag)) && guard++ < 60) out[(m[1] as string).toLowerCase()] = decodeEntities((m[2] ?? m[3] ?? m[4] ?? "") as string);
  return out;
}

/** Control characters, zero-width and bidirectional-override characters, line/paragraph separators and the byte-order mark. */
const CONTROL_CHARS = new RegExp("[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]", "g");

const LD_TYPE_SKIP = /^(WebSite|WebPage|ItemList|ListItem|BreadcrumbList|SearchAction|ImageObject|Person|Review|Rating|AggregateRating|Question|Answer|FAQPage|Offer|PostalAddress|ContactPoint|Thing|CollectionPage|SiteNavigationElement|Organization|LocalBusiness)$/;
const humanType = (t: string): string => t.replace(/^.*[/#]/, "").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
/** Kinds of thing a page declares that are about the PAGE or a place, never the business itself. */
const LD_NOT_BUSINESS = /^(Article|BlogPosting|NewsArticle|AboutPage|ContactPage|WebPage|CollectionPage|FAQPage|ItemPage|ProfilePage|WebSite|OpeningHoursSpecification|City|Place|AdministrativeArea|State|Country|GeoCoordinates|ImageObject|Person|Review|Rating|AggregateRating|Question|Answer|Offer|PostalAddress|ContactPoint|BreadcrumbList|ListItem|ItemList|SearchAction|ReadAction|Thing|SiteNavigationElement|WPHeader|WPFooter|SiteNavigationElement)$/;
const ldStr = (v: unknown, n = 200): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const ldNames = (v: unknown): string[] => {
  if (typeof v === "string") return [ldStr(v)].filter(Boolean);
  if (Array.isArray(v)) return v.flatMap(ldNames);
  if (v && typeof v === "object") { const o = v as Record<string, unknown>; return ldNames(o.name ?? o.addressLocality ?? o["@id"]); }
  return [];
};

/**
 * Facts a site declares about itself in schema.org JSON-LD (data, never executed): name, kind of business, address, phone, service area,
 * services. Returned as plain labelled lines so they read like any other page text and quotes can be checked against them.
 */
export function ldLines(json: string): string[] {
  let data: unknown;
  try { data = JSON.parse(json.slice(0, 200_000)); } catch { return []; }
  const out: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 6 || seen.has(node) || out.length > 60) return;
    seen.add(node);
    if (Array.isArray(node)) { for (const x of node.slice(0, 60)) visit(x, depth + 1); return; }
    const o = node as Record<string, unknown>;
    const types = ([] as unknown[]).concat(o["@type"] ?? []).map((t) => humanType(String(t))).filter(Boolean);
    const compact = (t: string) => t.replace(/ /g, "");
    const specific = types.filter((t) => !LD_TYPE_SKIP.test(compact(t)) && !LD_NOT_BUSINESS.test(compact(t)));
    const isOffering = types.some((t) => /^(Service|Product)$/.test(compact(t)));
    const isBusiness = !isOffering && types.some((t) => !LD_NOT_BUSINESS.test(compact(t)) && /(business|store|shop|restaurant|contractor|plumber|electrician|dentist|clinic|salon|agency|company|organization|school|gym|studio|hotel|cafe|bakery|attorney|lawyer|accountant|repair|cleaning|roofing|landscap|auto|hvac|service)/i.test(t));
    if (isOffering) { const n = ldStr(o.name, 100); if (n) out.push(`Service (site data): ${n}`); }
    if (isBusiness) {
      const name = ldStr(o.name, 120);
      if (name) out.push(`Name (site data): ${name}`);
      for (const t of specific.slice(0, 2)) out.push(`Business type (site data): ${t}`);
      const desc = ldStr(o.description, 300);
      if (desc) out.push(`Description (site data): ${desc}`);
      const area = ldNames(o.areaServed).slice(0, 10);
      if (area.length) out.push(`Service area (site data): ${area.join(", ")}`);
      const adr = o.address;
      if (adr && typeof adr === "object") {
        const a = adr as Record<string, unknown>;
        const parts = [ldStr(a.streetAddress, 80), ldStr(a.addressLocality, 60), ldStr(a.addressRegion, 30), ldStr(a.postalCode, 12)].filter(Boolean);
        if (parts.length) out.push(`Address (site data): ${parts.join(", ")}`);
      } else if (typeof adr === "string") out.push(`Address (site data): ${ldStr(adr, 160)}`);
      const phone = ldStr(o.telephone, 40);
      if (phone) out.push(`Phone (site data): ${phone}`);
      for (const s of ldNames(o.serviceType).slice(0, 12)) out.push(`Service (site data): ${s}`);
      const offers = (o.hasOfferCatalog ?? o.makesOffer ?? o.offers) as unknown;
      const collect = (v: unknown, d: number): void => {
        if (!v || d > 4) return;
        if (Array.isArray(v)) { v.slice(0, 40).forEach((x) => collect(x, d + 1)); return; }
        if (typeof v === "object") { const x = v as Record<string, unknown>; const n = ldStr(x.name, 100); if (n && (x["@type"] === "Service" || x["@type"] === "Product" || x.itemOffered)) out.push(`Service (site data): ${n}`); collect(x.itemOffered, d + 1); collect(x.itemListElement, d + 1); collect(x.hasOfferCatalog, d + 1); }
      };
      collect(offers, 0);
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") visit(v, depth + 1);
  };
  visit(data, 0);
  return [...new Set(out)];
}

export function extractPage(html: string): ExtractedPage {
  const lower = html.toLowerCase();
  const n = html.length;
  const out: string[] = [];
  const links: PageLink[] = [];
  let linkBuf: string[] | null = null;
  let linkHref = "";
  let title = "";
  let description = "";
  let robotsMeta = "";
  let siteName = "";
  const structured: string[] = [];
  const emit = (s: string) => { out.push(s); if (linkBuf) linkBuf.push(s); };
  const closeLink = () => {
    if (!linkBuf) return;
    const text = decodeEntities(linkBuf.join("")).replace(/\s+/g, " ").trim().slice(0, 120);
    if (links.length < 400) links.push({ href: linkHref, text });
    linkBuf = null;
  };

  let i = 0;
  let scanned = 0; // characters examined while looking for the end of tags: bounded, so malformed markup cannot make this slow
  const scanBudget = 16 * n + 100_000;
  let inBody = false; // text before <body> (if any) is head content
  const hasBody = lower.includes("<body");
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { if (inBody || !hasBody) emit(html.slice(i)); break; }
    if (lt > i && (inBody || !hasBody)) emit(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) { const end = html.indexOf("-->", lt + 4); i = end < 0 ? n : end + 3; continue; }
    const closing = html[lt + 1] === "/";
    const nameStart = lt + (closing ? 2 : 1);
    const nm = /^[a-z][a-z0-9-]*/i.exec(html.slice(nameStart, nameStart + 24));
    if (!nm) { if (inBody || !hasBody) emit("<"); i = lt + 1; continue; }
    const name = nm[0].toLowerCase();
    // end of the tag, honouring quotes, bounded
    let k = nameStart + name.length;
    let q = "";
    const limit = Math.min(n, lt + 4096);
    for (; k < limit; k++) {
      const ch = html[k] as string;
      if (q) { if (ch === q) q = ""; } else if (ch === '"' || ch === "'") q = ch; else if (ch === ">") break;
    }
    scanned += k - lt;
    if (scanned > scanBudget) break; // pathological markup: the rest is dropped, not guessed at
    if (k >= limit) { if (inBody || !hasBody) emit("<"); i = lt + 1; continue; }
    const tag = html.slice(lt, k + 1);
    i = k + 1;

    if (!closing && name === "title") {
      const end = lower.indexOf("</title", i);
      if (!title) title = decodeEntities(html.slice(i, end < 0 ? Math.min(n, i + 300) : Math.min(end, i + 300))).replace(/\s+/g, " ").trim();
      i = end < 0 ? n : end;
      continue;
    }
    if (!closing && name === "meta") {
      const a = attrs(tag);
      const key = (a.name ?? a.property ?? "").toLowerCase();
      if ((key === "og:site_name" || key === "application-name") && !siteName) siteName = (a.content ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
      if (key === "description" || key === "og:description") { if (!description) description = (a.content ?? "").replace(/\s+/g, " ").trim().slice(0, 400); }
      else if (key === "robots" || key === "googlebot") robotsMeta += ` ${(a.content ?? "").toLowerCase()}`;
      continue;
    }
    if (name === "body") { if (!closing) inBody = true; continue; }
    if (!closing && name === "script" && /ld\+json/i.test(attrs(tag).type ?? "")) {
      const end = lower.indexOf("</script", i);
      if (structured.length < 60) structured.push(...ldLines(html.slice(i, end < 0 ? Math.min(n, i + 200_000) : Math.min(end, i + 200_000))));
    }
    if (!closing && SKIP.has(name)) {
      if (name === "head") continue; // enter the head normally: its title/meta are read above; other head content is not text
      const end = lower.indexOf(`</${name}`, i);
      const close = end < 0 ? -1 : html.indexOf(">", end);
      i = close < 0 ? n : close + 1;
      continue;
    }
    if (!inBody && hasBody) continue;
    if (name === "a") {
      if (closing) closeLink();
      else { closeLink(); const href = attrs(tag).href; if (href) { linkHref = href; linkBuf = []; } }
      continue;
    }
    if (BLOCK.has(name)) emit(!closing && HEADING.has(name) ? "\n# " : "\n");
  }
  closeLink();

  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of decodeEntities(out.join("")).split("\n")) {
    const line = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
    if (line.length < 2) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue; // repeated menus and footers
    seen.add(key);
    lines.push(line);
  }
  const siteLines = [...new Set(structured)].filter((x) => !seen.has(x.toLowerCase()));
  return { title, siteName, description, robotsMeta: robotsMeta.trim(), text: [...siteLines, ...lines].join("\n"), links };
}
