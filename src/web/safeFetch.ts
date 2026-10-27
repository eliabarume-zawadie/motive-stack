import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { LookupAddress } from "node:dns";
import { assertPublicHostName, isPublicAddress, parseWebsiteUrl, UnsafeUrlError } from "./urlSafety.js";

/**
 * The only way this application fetches a customer's website.
 *
 *  - Every address a name resolves to is checked AT CONNECTION TIME, inside the socket's own lookup, and the connection is made to the
 *    address that was checked. A second, separate resolution (the DNS rebinding gap) never happens.
 *  - Redirects are followed by hand: at most a few, each one re-validated like a new URL, never from https to http, and never to a
 *    different site (the owner is told where it went instead).
 *  - No cookies, no credentials, no JavaScript. Compressed responses are not requested (and refused if sent), so a small download
 *    cannot expand into a large one.
 *  - Size and time are capped; an oversized response is refused, not truncated.
 *  - Only HTML-like (or, for robots.txt, plain-text) content is read.
 */

export type FetchErrorCode =
  | "blocked_address" | "invalid_url" | "timeout" | "too_large" | "unsupported_type" | "unsupported_encoding"
  | "redirect_offsite" | "redirect_downgrade" | "redirect_limit" | "dns" | "network";

export class FetchError extends Error {
  constructor(readonly code: FetchErrorCode, message: string, readonly detail?: string) {
    super(message);
    this.name = "FetchError";
  }
}

export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
}

export const DEFAULT_LIMITS: FetchLimits = { timeoutMs: 8000, maxBytes: 600_000, maxRedirects: 3 };

export interface FetchedPage {
  /** The URL that finally answered, after any redirects. */
  url: string;
  status: number;
  contentType: string;
  body: string;
  bytes: number;
  /** X-Robots-Tag header value, lower-cased, or "". */
  robotsTag: string;
}

export interface FetchDeps {
  /** Name resolution. Defaults to the system resolver. Tests replace it. */
  resolve?: (host: string) => Promise<LookupAddress[]>;
  /** TEST SEAM ONLY (never read from the environment): connect to this local address instead, after the resolved addresses were validated as usual. */
  testConnectOverride?: { address: string; port: number };
}

export const USER_AGENT = "MotiveStackBot/0.1 (business-brain analysis; reads only the pages you asked us to read)";

const systemResolve = (host: string): Promise<LookupAddress[]> => dns.promises.lookup(host, { all: true, verbatim: true });

/** "www.example.com" and "example.com" are the same site; nothing else is. */
export const siteKey = (host: string): string => host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

export interface FetchOptions {
  accept: "html" | "text";
  /** The site this fetch started on: redirects may not leave it. */
  site: string;
  limits?: Partial<FetchLimits>;
  signal?: AbortSignal;
}

export async function safeFetch(startUrl: string | URL, opts: FetchOptions, deps: FetchDeps = {}): Promise<FetchedPage> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const resolve = deps.resolve ?? systemResolve;
  let url: URL;
  try { url = typeof startUrl === "string" ? parseWebsiteUrl(startUrl) : parseWebsiteUrl(startUrl.href); } catch (e) {
    throw new FetchError("invalid_url", e instanceof UnsafeUrlError ? e.message : "Invalid address.");
  }
  if (siteKey(url.hostname) !== opts.site) throw new FetchError("redirect_offsite", "That page is on a different site, so it was not read.");

  for (let hop = 0; ; hop++) {
    const res = await once(url, opts, limits, resolve, deps);
    if (res.redirect) {
      if (hop >= limits.maxRedirects) throw new FetchError("redirect_limit", "The website redirected too many times.");
      let next: URL;
      try { next = parseWebsiteUrl(new URL(res.redirect, url).href); } catch (e) {
        throw new FetchError("invalid_url", e instanceof UnsafeUrlError ? "The website redirected somewhere that cannot be analyzed." : "The website sent an invalid redirect.");
      }
      if (url.protocol === "https:" && next.protocol === "http:") throw new FetchError("redirect_downgrade", "The website tried to redirect from a secure (https) to an insecure (http) address, so it was not followed.");
      if (siteKey(next.hostname) !== opts.site) throw new FetchError("redirect_offsite", "The website redirected to a different site.", next.hostname);
      url = next;
      continue;
    }
    return res.page as FetchedPage;
  }
}

interface Hop { redirect?: string; page?: FetchedPage }

function once(url: URL, opts: FetchOptions, limits: FetchLimits, resolve: NonNullable<FetchDeps["resolve"]>, deps: FetchDeps): Promise<Hop> {
  return new Promise<Hop>((resolveHop, reject) => {
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(deadline); fn(); } };
    const fail = (e: FetchError) => finish(() => { req.destroy(); reject(e); });

    // Validation happens HERE, for the addresses this very connection will use.
    const lookup = (hostname: string, options: unknown, cb: (err: Error | null, address?: string | LookupAddress[], family?: number) => void) => {
      const wantAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
      resolve(hostname).then((addrs) => {
        if (!addrs.length) return cb(new FetchError("dns", "The website's name did not resolve."));
        const bad = addrs.find((a) => !isPublicAddress(a.address));
        if (bad) return cb(new FetchError("blocked_address", "That website's name points to a private or internal address, so it was not contacted."));
        const target = deps.testConnectOverride ? [{ address: deps.testConnectOverride.address, family: 4 }] : addrs;
        if (wantAll) cb(null, target as LookupAddress[]);
        else cb(null, (target[0] as LookupAddress).address, (target[0] as LookupAddress).family);
      }, (e: unknown) => cb(new FetchError("dns", "The website's name could not be found.", e instanceof Error ? e.message : undefined)));
    };

    const deadline = setTimeout(() => fail(new FetchError("timeout", "The website took too long to answer.")), limits.timeoutMs);
    const onAbort = () => fail(new FetchError("network", "The analysis was cancelled."));
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request({
      method: "GET",
      hostname: url.hostname,
      port: deps.testConnectOverride ? deps.testConnectOverride.port : undefined,
      path: `${url.pathname}${url.search}`,
      headers: {
        host: url.host,
        "user-agent": USER_AGENT,
        accept: opts.accept === "html" ? "text/html,application/xhtml+xml;q=0.9" : "text/plain",
        "accept-encoding": "identity",
        "accept-language": "en",
      },
      lookup: lookup as never,
      agent: false,
      timeout: limits.timeoutMs,
    }, (res) => {
      const status = res.statusCode ?? 0;
      const header = (n: string) => String(res.headers[n] ?? "");
      if (status >= 300 && status < 400 && header("location")) { res.resume(); return finish(() => resolveHop({ redirect: header("location") })); }
      const encoding = header("content-encoding").toLowerCase();
      if (encoding && encoding !== "identity") { res.resume(); return fail(new FetchError("unsupported_encoding", "The website sent a compressed response that was not requested, so it was not read.")); }
      const contentType = header("content-type").toLowerCase();
      const okType = opts.accept === "html" ? /^(text\/html|application\/xhtml\+xml)\b/.test(contentType) : /^text\/plain\b/.test(contentType) || contentType === "";
      if (status >= 200 && status < 300 && !okType) { res.resume(); return fail(new FetchError("unsupported_type", "That page is not a web page (it is a file or another kind of content), so it was not read.")); }
      const declared = Number(header("content-length"));
      if (Number.isFinite(declared) && declared > limits.maxBytes) { res.resume(); return fail(new FetchError("too_large", "That page is too large to analyze.")); }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (c: Buffer) => {
        total += c.length;
        if (total > limits.maxBytes) return fail(new FetchError("too_large", "That page is too large to analyze."));
        chunks.push(c);
      });
      res.on("end", () => finish(() => {
        const charset = /charset=([\w-]+)/.exec(contentType)?.[1] ?? "utf-8";
        let body: string;
        try { body = new TextDecoder(charset, { fatal: false }).decode(Buffer.concat(chunks)); } catch { body = Buffer.concat(chunks).toString("utf8"); }
        resolveHop({ page: { url: url.href, status, contentType, body, bytes: total, robotsTag: header("x-robots-tag").toLowerCase() } });
      }));
      res.on("error", () => fail(new FetchError("network", "The connection to the website was interrupted.")));
    });
    req.on("timeout", () => fail(new FetchError("timeout", "The website took too long to answer.")));
    req.on("error", (e: Error) => {
      if (e instanceof FetchError) return fail(e);
      const cause = (e as { cause?: unknown }).cause;
      if (cause instanceof FetchError) return fail(cause);
      fail(new FetchError("network", "Could not connect to the website.", (e as NodeJS.ErrnoException).code));
    });
    req.end();
  });
}

export { assertPublicHostName };
