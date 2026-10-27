import { BlockList, isIP } from "node:net";

/**
 * Which network addresses and website URLs the analysis may contact.
 *
 * Only public web addresses are allowed. Everything that can reach this machine or the network around it is refused: loopback, private
 * ranges, link-local (including the cloud metadata address 169.254.169.254), carrier-grade NAT, multicast, reserved and documentation
 * ranges, and IPv6 forms that wrap an IPv4 address (mapped, NAT64, 6to4, Teredo), which are checked as the IPv4 address they carry.
 *
 * These checks run on the URL (to give the owner a plain message early) AND again on every address a name resolves to at the moment of
 * connecting (see safeFetch.ts), so a name that answers with a public address first and an internal one later cannot get through.
 */

const blocked = new BlockList();
const v4 = (net: string, prefix: number) => blocked.addSubnet(net, prefix, "ipv4");
const v6 = (net: string, prefix: number) => blocked.addSubnet(net, prefix, "ipv6");
v4("0.0.0.0", 8); // "this network"
v4("10.0.0.0", 8);
v4("100.64.0.0", 10); // carrier-grade NAT
v4("127.0.0.0", 8);
v4("169.254.0.0", 16); // link-local, cloud metadata
v4("172.16.0.0", 12);
v4("192.0.0.0", 24);
v4("192.0.2.0", 24);
v4("192.88.99.0", 24);
v4("192.168.0.0", 16);
v4("198.18.0.0", 15); // benchmarking
v4("198.51.100.0", 24);
v4("203.0.113.0", 24);
v4("224.0.0.0", 4); // multicast
v4("240.0.0.0", 4); // reserved, includes the broadcast address
v6("::", 128);
v6("::1", 128);
v6("64:ff9b:1::", 48); // local-use NAT64
v6("100::", 64); // discard-only
v6("2001:db8::", 32); // documentation
v6("fc00::", 7); // unique local
v6("fe80::", 10); // link-local
v6("fec0::", 10); // old site-local
v6("ff00::", 8); // multicast

/** The IPv4 address an IPv6 address carries, when it is one of the wrapping forms. */
function embeddedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  const hex = (a: string, b: string) => `${parseInt(a, 16) >> 8}.${parseInt(a, 16) & 255}.${parseInt(b, 16) >> 8}.${parseInt(b, 16) & 255}`;
  // IPv4-mapped, dotted (::ffff:1.2.3.4) or hex (::ffff:102:304); IPv4-compatible (::1.2.3.4)
  let m = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (m) return m[1] as string;
  m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (m) return hex(m[1] as string, m[2] as string);
  m = /^64:ff9b::(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(lower); // NAT64
  if (m) return m[1] ?? hex(m[2] as string, m[3] as string);
  m = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/.exec(lower); // 6to4
  if (m) return hex(m[1] as string, m[2] as string);
  if (lower.startsWith("2001:0:") || lower.startsWith("2001::")) return "0.0.0.0"; // Teredo: tunnelled, never a website host
  return null;
}

/** True only for a public, routable address. Anything that is not a valid IP literal is refused. */
export function isPublicAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 0) return false;
  if (kind === 4) return !blocked.check(ip, "ipv4");
  const inner = embeddedV4(ip);
  if (inner) return isPublicAddress(inner);
  return !blocked.check(ip, "ipv6");
}

export type UrlProblem = "empty" | "too_long" | "bad_url" | "scheme" | "credentials" | "port" | "ip_literal" | "internal_name" | "no_dot";

const PROBLEM_TEXT: Record<UrlProblem, string> = {
  empty: "Enter your website address, for example https://www.example.com",
  too_long: "That address is too long.",
  bad_url: "That does not look like a website address. Try something like https://www.example.com",
  scheme: "Only web addresses that start with https:// or http:// can be analyzed.",
  credentials: "Leave out any username or password in the address.",
  port: "Only standard web ports are supported, so please use the plain address (no :port).",
  ip_literal: "Please use your website's name (like www.example.com), not a numeric address.",
  internal_name: "That address points to a private or internal location, so it cannot be analyzed.",
  no_dot: "That does not look like a public website name. Try something like www.example.com",
};

export class UnsafeUrlError extends Error {
  constructor(readonly problem: UrlProblem, message = PROBLEM_TEXT[problem]) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const INTERNAL_SUFFIXES = [".local", ".localhost", ".internal", ".intranet", ".lan", ".home", ".corp", ".private", ".test", ".example", ".invalid", ".arpa", ".onion"];

/** Checks a host NAME (not yet resolved). Throws UnsafeUrlError. */
export function assertPublicHostName(host: string): void {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") || isIP(h) !== 0 || /^[0-9.]+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) throw new UnsafeUrlError("ip_literal");
  if (h === "localhost" || INTERNAL_SUFFIXES.some((s) => h.endsWith(s))) throw new UnsafeUrlError("internal_name");
  if (!h.includes(".")) throw new UnsafeUrlError("no_dot");
}

/**
 * Turns what the owner typed into a URL that is safe to even attempt, or throws UnsafeUrlError with a plain message.
 * A bare name such as "example.com" is read as https. Credentials, non-standard ports, IP literals and internal names are refused.
 * The fragment is dropped. The WHATWG URL parser has already normalised odd numeric forms (http://2130706433, http://0x7f.1) into
 * dotted IPv4, which the IP-literal check then refuses.
 */
export function parseWebsiteUrl(input: string, opts: { allowHttp?: boolean } = {}): URL {
  const raw = String(input ?? "").trim();
  if (!raw) throw new UnsafeUrlError("empty");
  if (raw.length > 2048) throw new UnsafeUrlError("too_long");
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/]*:\d+(\/|$)/.test(raw) ? raw : `https://${raw}`;
  let u: URL;
  try { u = new URL(withScheme); } catch { throw new UnsafeUrlError("bad_url"); }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && opts.allowHttp !== false)) throw new UnsafeUrlError("scheme");
  if (u.username || u.password) throw new UnsafeUrlError("credentials");
  if (u.port !== "") throw new UnsafeUrlError("port"); // the parser drops the default port, so any left over is non-standard
  assertPublicHostName(u.hostname);
  u.hash = "";
  return u;
}
