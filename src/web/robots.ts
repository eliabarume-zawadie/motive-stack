/**
 * robots.txt, read the way RFC 9309 describes (the parts that matter for a polite single-purpose reader):
 *  - the most specific matching user-agent group applies, otherwise "*";
 *  - the longest matching Allow/Disallow path wins; on a tie, Allow wins;
 *  - "*" matches any run of characters and a trailing "$" anchors the end.
 */

export interface RobotsRule { allow: boolean; pattern: string }
export interface Robots { rules: RobotsRule[]; hasGroup: boolean }

export const ALLOW_ALL: Robots = { rules: [], hasGroup: false };
export const DISALLOW_ALL: Robots = { rules: [{ allow: false, pattern: "/" }], hasGroup: true };

const MAX_LINES = 2000;

export function parseRobots(text: string, agentToken = "motivestackbot"): Robots {
  const groups: Array<{ agents: string[]; rules: RobotsRule[] }> = [];
  let cur: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/).slice(0, MAX_LINES)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = (m[1] as string).toLowerCase();
    const value = (m[2] as string).trim();
    if (field === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((field === "allow" || field === "disallow") && cur) {
      if (value === "" && field === "disallow") continue; // "Disallow:" with nothing means allow everything
      cur.rules.push({ allow: field === "allow", pattern: value.slice(0, 512) });
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && agentToken.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return { rules: chosen.flatMap((g) => g.rules), hasGroup: chosen.length > 0 };
}

function matches(pattern: string, path: string): number {
  // returns the match length (for "longest wins") or -1
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split("*");
  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (i === 0) { if (!path.startsWith(part)) return -1; pos = part.length; continue; }
    const idx = path.indexOf(part, pos);
    if (idx < 0) return -1;
    pos = idx + part.length;
  }
  if (anchored && pos !== path.length && !(parts.length > 1 && (parts[parts.length - 1] as string) === "")) return -1;
  return body.length;
}

/** `pathAndQuery` is the request target, e.g. "/about?x=1". */
export function robotsAllows(robots: Robots, pathAndQuery: string): boolean {
  let best = -1;
  let allowed = true;
  for (const r of robots.rules) {
    const len = matches(r.pattern, pathAndQuery);
    if (len < 0) continue;
    if (len > best || (len === best && r.allow)) { best = len; allowed = r.allow; }
  }
  return allowed;
}
