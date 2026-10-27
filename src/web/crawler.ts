import { extractPage } from "./htmlText.js";
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, robotsAllows, type Robots } from "./robots.js";
import { FetchError, safeFetch, siteKey, type FetchDeps, type FetchLimits } from "./safeFetch.js";
import { parseWebsiteUrl } from "./urlSafety.js";

/**
 * A small, polite, bounded reader for ONE website. It starts at the address the owner gave, reads the homepage, and follows a handful of
 * same-site links that look like About / Services / Products / Locations / Contact pages. It stops at fixed limits (pages, bytes,
 * characters, seconds). It respects robots.txt and per-page robots directives, and it never tries to get around a block, a login,
 * a CAPTCHA or a bot challenge: it reports them and stops.
 */

export interface CrawlConfig {
  maxPages: number;
  perPageChars: number;
  totalChars: number;
  totalTimeoutMs: number;
  limits: Partial<FetchLimits>;
}

export const DEFAULT_CRAWL: CrawlConfig = { maxPages: 8, perPageChars: 8000, totalChars: 40_000, totalTimeoutMs: 60_000, limits: {} };

export interface CrawledPage {
  url: string;
  title: string;
  description: string;
  text: string;
  status: "read" | "skipped" | "failed";
  /** Why a page was skipped or failed, in plain words. */
  reason: string | null;
  bytes: number;
  chars: number;
  /** The page contains wording that tries to instruct an AI. It is still treated purely as data. */
  looksLikeInstructions: boolean;
}

export type RobotsState = "allowed" | "no_robots_file" | "restricted" | "unavailable";

export interface CrawlResult {
  startUrl: string;
  site: string;
  robots: RobotsState;
  pages: CrawledPage[];
  notes: string[];
}

export type CrawlRefusalCode = "robots_disallow" | "blocked_by_site" | "homepage_failed";
export class CrawlRefused extends Error {
  constructor(readonly code: CrawlRefusalCode, message: string, readonly detail?: string) {
    super(message);
    this.name = "CrawlRefused";
  }
}

/** Pages worth trying by name when the homepage's own links do not lead to them (each one is checked against robots.txt first). */
const WELL_KNOWN: Array<[RegExp, string[]]> = [
  [/\babout\b|\bwho[-_ ]we[-_ ]are\b|\bour[-_ ]story\b|\bcompany\b/, ["/about", "/about-us"]],
  [/\bservices?\b|\bwhat[-_ ]we[-_ ]do\b|\bsolutions?\b|\bproducts?\b/, ["/services", "/our-services", "/products"]],
  [/\bcontact\b|\bget[-_ ]in[-_ ]touch\b/, ["/contact", "/contact-us"]],
  [/\bservice[-_ ]areas?\b|\bareas?[-_ ]served\b|\blocations?\b/, ["/service-areas", "/locations"]],
];
/** A link under a services/products section: its text is a service or product name. */
const SERVICE_CHILD = /\/(services?|products?|what-we-do|solutions|treatments|specialt(?:y|ies)|offerings|menu)\/[^/]+/i;
const GENERIC_LINK = /^(?:home|about(?: us)?|contact(?: us)?|services?|our services|products?|blogs?(?: & updates)?|news|faqs?|gallery|reviews?|testimonials?|careers?|login|log in|get a (?:free )?quote|request a quote|learn more|read more|view all|see all|more|menu|shop|cart|privacy(?: policy)?|terms(?: of service)?|search|skip to content|explore(?: service)?|financing|warranty|science|info)$|^(?:calculate|savings? calculator|talk to|get my|book |schedule |call |request |click )/i;

const KEYWORDS: Array<[RegExp, number]> = [
  [/\babout\b|\bwho[-_ ]we[-_ ]are\b|\bour[-_ ]story\b|\bcompany\b|\bteam\b/, 6],
  [/\bservices?\b|\bwhat[-_ ]we[-_ ]do\b|\bsolutions?\b|\bofferings?\b|\bspecialt/, 6],
  [/\bproducts?\b|\bshop\b|\bmenu\b|\bcatalog/, 5],
  [/\blocations?\b|\bservice[-_ ]areas?\b|\bareas?[-_ ]served\b|\bwhere\b|\bcities\b/, 5],
  [/\bcontact\b|\bget[-_ ]in[-_ ]touch\b|\bvisit\b|\bhours\b/, 4],
  [/\bpricing\b|\bprices?\b|\bplans?\b|\bquote\b|\bestimate\b|\bfaq\b|\bwhy[-_ ]/, 2],
];
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|bmp|zip|gz|rar|7z|docx?|xlsx?|pptx?|mp[34]|mov|avi|wmv|css|js|json|xml|rss|woff2?|ttf|eot|exe|dmg|apk)$/i;
const SKIP_PATH = /\/(login|log-in|signin|sign-in|signup|sign-up|register|cart|checkout|account|my-account|admin|wp-admin|wp-login|cdn-cgi|search|privacy|terms|cookie)/i;
const INJECTION = [
  /ignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|prompts?|rules)/i,
  /disregard (?:all |any |the )?(?:previous|prior|above|your)\b[^.\n]{0,40}(?:instructions|rules|prompt)/i,
  /\b(?:system|developer) prompt\b/i,
  /you are (?:now )?(?:an? )?(?:ai|assistant|chatgpt|language model|llm)\b/i,
  /\b(?:reveal|print|show|send|output)\b[^.\n]{0,40}\b(?:api[-_ ]?key|secret|password|token|credentials?)\b/i,
  /<\/?(?:system|assistant|tool)>/i,
  /\bapprove (?:this|the) (?:campaign|proposal)\b/i,
];

export const looksLikeInstructions = (text: string): boolean => INJECTION.some((re) => re.test(text));

/** True when the page is a bot-challenge, login wall or block page rather than the site's own content. */
function looksBlocked(status: number, text: string, html: string): boolean {
  if (status === 401 || status === 403 || status === 429 || status === 503) return true;
  const short = text.length < 600;
  return short && /captcha|cf-chl|just a moment|attention required|checking your browser|access denied|are you a robot|enable javascript and cookies|verify you are (?:a )?human|incapsula|px-captcha|ddos protection/i.test(html.slice(0, 6000));
}

function scoreLink(u: URL, text: string): number {
  const hay = `${decodeURIComponent(u.pathname).toLowerCase()} ${text.toLowerCase()}`;
  let s = 0;
  for (const [re, w] of KEYWORDS) if (re.test(hay)) s = Math.max(s, w);
  if (s === 0) return 0;
  const depth = u.pathname.split("/").filter(Boolean).length;
  return s - Math.min(depth - 1, 3) * 0.5 - (u.search ? 1 : 0);
}

/** Names of the services/products the site's own menus point to ("Service link (site data): AC repair"), so they are read as page text. */
function serviceLinkLines(links: Array<{ href: string; text: string }>, base: URL): string[] {
  const out: string[] = [];
  for (const l of links) {
    let u: URL;
    try { u = new URL(l.href, base); } catch { continue; }
    if (!SERVICE_CHILD.test(u.pathname)) continue;
    const t = l.text.replace(/\s+/g, " ").trim();
    if (t.length < 3 || t.length > 60 || t.split(" ").length > 8 || GENERIC_LINK.test(t)) continue;
    out.push(`Service link (site data): ${t}`);
  }
  return [...new Set(out)].slice(0, 25);
}

const reasonFor = (e: unknown): string => (e instanceof FetchError ? e.message : "The page could not be read.");

export async function crawlSite(startInput: string, cfg: CrawlConfig = DEFAULT_CRAWL, deps: FetchDeps = {}, onProgress?: (msg: string) => void, signal?: AbortSignal): Promise<CrawlResult> {
  const start = parseWebsiteUrl(startInput); // throws UnsafeUrlError with a plain message
  const site = siteKey(start.hostname);
  const startedAt = Date.now();
  const notes: string[] = [];
  const pages: CrawledPage[] = [];
  const opts = { site, limits: cfg.limits, signal } as const;
  const timeLeft = () => cfg.totalTimeoutMs - (Date.now() - startedAt);

  // robots.txt first. A missing file (404 and similar) means "no restrictions"; a server error or no answer means "do not read".
  let robots: Robots = ALLOW_ALL;
  let robotsState: RobotsState = "no_robots_file";
  onProgress?.("Checking the site's rules for automated visitors (robots.txt)");
  try {
    const r = await safeFetch(new URL("/robots.txt", start.origin), { ...opts, accept: "text" }, deps);
    if (r.status >= 200 && r.status < 300) { robots = parseRobots(r.body.slice(0, 200_000)); robotsState = robots.rules.length ? "restricted" : "allowed"; }
    else if (r.status >= 400 && r.status < 500) { robots = ALLOW_ALL; robotsState = "no_robots_file"; }
    else { robots = DISALLOW_ALL; robotsState = "unavailable"; }
  } catch (e) {
    if (e instanceof FetchError && (e.code === "unsupported_type" || e.code === "too_large")) { robots = ALLOW_ALL; robotsState = "no_robots_file"; }
    else if (e instanceof FetchError) throw new CrawlRefused("homepage_failed", `${reasonFor(e)} Nothing was read.`, e.code); // the site itself could not be reached or is not allowed: say that, not "robots"
    else { robots = DISALLOW_ALL; robotsState = "unavailable"; }
  }
  if (robotsState === "unavailable") throw new CrawlRefused("robots_disallow", "The site's robots.txt could not be read, so to be safe nothing was fetched. Try again later, or describe your business manually.");
  const allowed = (u: URL) => robotsAllows(robots, `${u.pathname}${u.search}`);
  if (!allowed(start)) throw new CrawlRefused("robots_disallow", "This website asks automated visitors not to read this page (robots.txt), so MotiveStack did not read it. You can describe your business manually instead.");

  let usedChars = 0;
  const seenLines = new Set<string>(); // menus, footers and the site's own data block repeat on every page: each line is kept once
  const readPage = async (url: URL, isHome: boolean): Promise<{ page: CrawledPage; links: Array<{ href: string; text: string }> } | null> => {
    onProgress?.(`Reading ${url.pathname === "/" ? "the homepage" : url.pathname}`);
    try {
      const res = await safeFetch(url, { ...opts, accept: "html", limits: { ...cfg.limits, timeoutMs: Math.min(cfg.limits.timeoutMs ?? 8000, Math.max(1000, timeLeft())) } }, deps);
      const ex = extractPage(res.body);
      if (looksBlocked(res.status, ex.text, res.body)) {
        if (isHome) throw new CrawlRefused("blocked_by_site", "This website blocks automated visitors (a login, CAPTCHA or bot check). MotiveStack does not try to get around that. You can describe your business manually instead.");
        return { page: { url: res.url, title: "", description: "", text: "", status: "skipped", reason: "The site blocked this page for automated visitors.", bytes: res.bytes, chars: 0, looksLikeInstructions: false }, links: [] };
      }
      if (res.status < 200 || res.status >= 300) {
        return { page: { url: res.url, title: "", description: "", text: "", status: "failed", reason: `The page answered with status ${res.status}.`, bytes: res.bytes, chars: 0, looksLikeInstructions: false }, links: [] };
      }
      const directives = `${ex.robotsMeta} ${res.robotsTag}`;
      if (/\bnoai\b|\bnone\b/.test(directives)) {
        return { page: { url: res.url, title: ex.title, description: "", text: "", status: "skipped", reason: "The page asks not to be used by AI tools (robots directive).", bytes: res.bytes, chars: 0, looksLikeInstructions: false }, links: [] };
      }
      const room = Math.max(0, Math.min(cfg.perPageChars, cfg.totalChars - usedChars));
      const menu = serviceLinkLines(ex.links, new URL(res.url));
      const fresh = [...(ex.siteName ? [`Site name (site data): ${ex.siteName}`] : []), ...menu, ...ex.text.split("\n")].filter((l) => {
        const k = l.toLowerCase();
        if (l.length <= 90 && seenLines.has(k)) return false;
        if (l.length <= 90) seenLines.add(k);
        return true;
      });
      const text = fresh.join("\n").slice(0, room);
      usedChars += text.length;
      return {
        page: { url: res.url, title: ex.title.slice(0, 200), description: ex.description, text, status: "read", reason: ex.text.length > room ? "Only the first part of this page was used." : null, bytes: res.bytes, chars: text.length, looksLikeInstructions: looksLikeInstructions(text) },
        links: /\bnofollow\b/.test(directives) ? [] : ex.links,
      };
    } catch (e) {
      if (e instanceof CrawlRefused) throw e;
      if (isHome) throw new CrawlRefused("homepage_failed", reasonFor(e), e instanceof FetchError ? e.code : undefined);
      return { page: { url: url.href, title: "", description: "", text: "", status: "failed", reason: reasonFor(e), bytes: 0, chars: 0, looksLikeInstructions: false }, links: [] };
    }
  };

  const home = await readPage(start, true);
  if (!home) throw new CrawlRefused("homepage_failed", "The homepage could not be read.");
  pages.push(home.page);
  if (home.page.status !== "read") throw new CrawlRefused("homepage_failed", home.page.reason ?? "The homepage could not be read.");

  // Pages worth reading are found from the links on EVERY page that is read (menus, "our services" pages and their children), best first.
  const base = new URL(home.page.url);
  const seen = new Set<string>([base.href.replace(/\/$/, ""), start.href.replace(/\/$/, "")]);
  const queue: Array<{ url: URL; score: number }> = [];
  const enqueue = (links: Array<{ href: string; text: string }>, from: URL, bonus = 0) => {
    for (const l of links) {
      let u: URL;
      try { u = new URL(l.href, from); } catch { continue; }
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
      u.hash = "";
      if (siteKey(u.hostname) !== site || u.port !== "" || u.username || u.password) continue;
      if (SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) continue;
      if (u.protocol === "http:" && base.protocol === "https:") u.protocol = "https:"; // never read the plain-http twin of a secure site
      const key = u.href.replace(/\/$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      if (!allowed(u)) continue;
      let score = scoreLink(u, l.text);
      if (score === 0 && SERVICE_CHILD.test(u.pathname)) score = 3; // a page about one service or product
      if (score > 0) queue.push({ url: u, score: score + bonus });
    }
  };
  enqueue(home.links, base);

  // A kind of page the homepage does not link to is tried by its usual name (each name is checked against robots.txt first).
  const linked = (re: RegExp) => queue.some((c) => re.test(decodeURIComponent(c.url.pathname).toLowerCase()));
  let guesses = 0;
  for (const [re, paths] of WELL_KNOWN) {
    if (linked(re) || guesses >= 4) continue;
    for (const p of paths) {
      const u = new URL(p, base.origin);
      const key = u.href.replace(/\/$/, "");
      if (seen.has(key) || !allowed(u)) continue;
      seen.add(key);
      queue.push({ url: u, score: 1 });
      guesses++;
      break;
    }
  }

  let skippedForLimit = false;
  while (queue.length) {
    if (pages.length >= cfg.maxPages) { skippedForLimit = true; break; }
    if (usedChars >= cfg.totalChars || timeLeft() < 1500) { notes.push("Stopped early to stay within the time and size limits."); break; }
    queue.sort((x, y) => y.score - x.score || x.url.href.length - y.url.href.length);
    const next = queue.shift() as { url: URL; score: number };
    const r = await readPage(next.url, false);
    if (!r) continue;
    const isGuess = next.score === 1 && r.page.status === "failed";
    if (!isGuess) pages.push(r.page); // a guessed name that does not exist is not shown as a failed page
    if (r.page.status === "read") enqueue(r.links, new URL(r.page.url), SERVICE_CHILD.test(new URL(r.page.url).pathname) ? 0 : /service|product|what-we-do|solutions/i.test(new URL(r.page.url).pathname) ? 2 : 0);
  }
  if ((skippedForLimit || queue.length) && !notes.length) notes.push(`Read ${pages.length} of the site's pages (the limit is ${cfg.maxPages}).`);
  return { startUrl: start.href, site, robots: robotsState, pages, notes };
}
