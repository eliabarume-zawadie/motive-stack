import { forbiddenClaimsUsed, groundingIssues } from "../domain/briefRules.js";
import type { BusinessBrain } from "../domain/schemas.js";
import type { BrandKit } from "../app/brandKit.js";
import { matchesRatio, RATIOS, type RatioId } from "./ratios.js";

/**
 * The creative quality gate. Every check here is DETERMINISTIC: plain rules that give the same answer for the same input, and each one says what to do about a
 * failure. Three different things are kept apart and labelled so nobody mistakes one for another:
 *   - deterministic checks (this file): length, format, size, colour contrast, alt text, avoid-terms, claims against the Business Brain, rights;
 *   - AI-assisted critique: NOT performed in this release (reported as "not performed", never as a pass);
 *   - human approval: a person approving the exact version, recorded separately.
 * The score is a review aid for a person ("how many of the automatic checks passed"), not a prediction of how an ad will perform.
 */
export type QaGroup = "technical" | "brand" | "factual" | "rights" | "accessibility" | "critique";
export type QaStatus = "pass" | "fail" | "warn" | "info" | "not_checked" | "not_performed";
export interface QaCheck { id: string; group: QaGroup; label: string; status: QaStatus; method: "deterministic" | "ai_critique"; message: string; repair?: string; ratio?: RatioId }

export interface Concept { headline: string; subline: string; callToAction: "SIGN_UP" | "LEARN_MORE" | "GET_QUOTE"; visualDescription: string; palette: { background: string; foreground: string; accent: string } }

export interface QaVariant {
  ratio: RatioId; source: "generated" | "imported"; mock: boolean;
  /** What reading the stored file back showed: ok, missing (not in the store) or corrupt (hash or structure does not match its record). */
  file: "ok" | "missing" | "corrupt";
  mime: string; width: number; height: number; sizeBytes: number;
  rightsBasis: string; rightsExpiresAt: string | null; assetStatus: string; assetArchived: boolean;
}

export interface QaInput {
  concept: Concept; altText: string; ratios: RatioId[]; variants: QaVariant[];
  brandKit: BrandKit | null; brandKitApproved: boolean;
  brain: BusinessBrain; asOf: Date; today: string; maxFileBytes: number;
}

export interface QaResult {
  checks: QaCheck[];
  /** True when no deterministic check failed. Warnings and "not performed" items do not block, but are shown. */
  passed: boolean;
  counts: Record<QaStatus, number>;
  score: { percent: number | null; of: number; note: string };
  ranAt?: string;
}

const norm = (s: string) => s.toLowerCase();
const wordIn = (hay: string, term: string) => new RegExp(`(^|[^\\p{L}\\p{N}])${term.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "iu").test(hay);

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const TESTIMONIAL = /("[^"]{8,}"\s*[-–—]\s*\w+|\b(testimonials?|reviews? (say|said)|customers? (say|said|love|loved|rave|raved)|clients? (say|said|love|loved)|[“”][^“”]{8,}[“”])|\b(rated|rating)\b|\b\d(\.\d)?\s?(\/\s?5|stars?)\b|\bfive[- ]star\b)/i;

export function runCreativeQa(i: QaInput): QaResult {
  const checks: QaCheck[] = [];
  const add = (c: QaCheck) => checks.push(c);
  const det = { method: "deterministic" as const };
  const { concept: k } = i;
  const copy = [k.headline, k.subline].filter((t) => t.trim().length > 0);

  // ---- technical: the files and the copy fit
  const lenBad: string[] = [];
  if (k.headline.trim().length < 1 || k.headline.length > 40) lenBad.push(`headline (${k.headline.length}/40)`);
  if (k.subline.length > 125) lenBad.push(`supporting line (${k.subline.length}/125)`);
  add({ id: "copy_length", group: "technical", label: "Copy fits the ad", ...det, status: lenBad.length ? "fail" : "pass",
    message: lenBad.length ? `Too long or empty: ${lenBad.join(", ")}.` : "The headline and supporting line fit the limits.", ...(lenBad.length ? { repair: "Shorten the headline to 40 characters and the supporting line to 125, then save a new version." } : {}) });

  for (const r of i.ratios) {
    const v = i.variants.find((x) => x.ratio === r);
    if (!v) { add({ id: `image_${r}`, group: "technical", label: `Image for ${r}`, ...det, status: "fail", ratio: r, message: `There is no image for the ${RATIOS[r].label} (${r}) format yet.`, repair: `Make the image for ${r}, attach an approved image of that shape, or remove ${r} from this version's formats.` }); continue; }
    if (v.file !== "ok") { add({ id: `image_${r}`, group: "technical", label: `Image for ${r}`, ...det, status: "fail", ratio: r, message: v.file === "missing" ? "The stored image file is missing." : "The stored image does not match its record, so it is not trusted.", repair: "Make the image again; this one cannot be used." }); continue; }
    const probs: string[] = [];
    if (v.mime !== "image/png" && v.mime !== "image/jpeg" && v.mime !== "image/webp") probs.push("unsupported type");
    if (!matchesRatio(v.width, v.height, r)) probs.push(`it is ${v.width}×${v.height}, not ${r}`);
    if (v.sizeBytes > i.maxFileBytes) probs.push("the file is too large");
    add({ id: `image_${r}`, group: "technical", label: `Image for ${r}`, ...det, status: probs.length ? "fail" : "pass", ratio: r,
      message: probs.length ? `The ${r} image is not usable: ${probs.join("; ")}.` : `The ${r} image is stored, readable and ${v.width}×${v.height}.`, ...(probs.length ? { repair: `Make the ${r} image again, or attach one that is exactly the ${r} shape.` } : {}) });
    if (v.mock) add({ id: `mock_${r}`, group: "technical", label: `Placeholder art (${r})`, ...det, status: "warn", ratio: r, message: "This image is placeholder art from the offline mock. It is not real artwork.", repair: "Replace it with real artwork (attach an approved image) before any real use." });
  }

  // ---- brand
  if (!i.brandKitApproved || !i.brandKit) add({ id: "brand_kit", group: "brand", label: "Approved Brand Kit", ...det, status: "warn", message: "There is no approved Brand Kit, so the brand checks below are limited.", repair: "Fill in and approve the Brand Kit in My business → Brand." });
  else {
    const text = copy.join(" \n ");
    const hits = i.brandKit.voice.avoidTerms.filter((t) => wordIn(text, t));
    add({ id: "avoid_terms", group: "brand", label: "Words to avoid", ...det, status: hits.length ? "fail" : "pass", message: hits.length ? `The copy uses words your Brand Kit says to avoid: ${hits.map((h) => `"${h}"`).join(", ")}.` : "The copy uses none of the words your Brand Kit says to avoid.", ...(hits.length ? { repair: "Reword the copy without those words and save a new version." } : {}) });
    const kitColours = new Set(i.brandKit.visual.colors.map((c) => norm(c.hex)));
    if (kitColours.size === 0) add({ id: "palette", group: "brand", label: "Brand colours", ...det, status: "not_checked", message: "Your Brand Kit lists no colours, so the picture's colours were not compared." });
    else {
      const off = (["background", "foreground", "accent"] as const).filter((r) => !kitColours.has(norm(k.palette[r])));
      add({ id: "palette", group: "brand", label: "Brand colours", ...det, status: off.length ? "warn" : "pass", message: off.length ? `Not in your Brand Kit colours: ${off.map((r) => `${r} ${k.palette[r]}`).join(", ")}.` : "The picture uses only colours from your Brand Kit.", ...(off.length ? { repair: "Pick those colours from the Brand Kit, or add them to it and get it approved." } : {}) });
    }
    if (i.brandKit.disclaimers.length) add({ id: "disclaimers", group: "brand", label: "Disclaimer wording", ...det, status: "info", message: `${i.brandKit.disclaimers.length} disclaimer wording${i.brandKit.disclaimers.length === 1 ? "" : "s"} in your Brand Kit may apply to this ad. Whether one is needed is not decided automatically.` });
  }

  // ---- factual: claims against the Business Brain, never against the Brand Kit
  const grounding = groundingIssues(copy, i.brain, { asOf: i.asOf });
  const forbidden = forbiddenClaimsUsed(copy, i.brain);
  const claimMsgs = [...grounding.map((g) => `"${g.text}" (${g.label}): ${g.reason === "unsupported" ? "nothing approved in the Business Brain supports it" : g.reason.replace(/_/g, " ")}`), ...forbidden.map((f) => `"${f.claim}" is a ${f.kind} claim`)];
  add({ id: "claims", group: "factual", label: "Claims match the Business Brain", ...det, status: claimMsgs.length ? "fail" : "pass",
    message: claimMsgs.length ? `The copy makes claims the Business Brain does not back: ${claimMsgs.join("; ")}.` : "The copy makes no claim the Business Brain does not support.",
    ...(claimMsgs.length ? { repair: "Remove or reword the claim, or add and verify the fact in the Business Brain first." } : {}) });
  const invented = TESTIMONIAL.test(copy.join(" \n "));
  add({ id: "testimonials", group: "factual", label: "No invented testimonials or ratings", ...det, status: invented ? "fail" : "pass",
    message: invented ? "The copy looks like a testimonial, review or rating. None are stored, so it would be invented." : "The copy contains no testimonial, review or rating.", ...(invented ? { repair: "Remove it. Only a real, owner-supplied testimonial may be used, and none can be stored yet." } : {}) });

  // ---- rights
  for (const v of i.variants.filter((x) => i.ratios.includes(x.ratio))) {
    const probs: string[] = [];
    if (v.rightsBasis === "unknown") probs.push("the right to use it is not stated");
    if (v.rightsExpiresAt && v.rightsExpiresAt < i.today) probs.push("its licence has expired");
    if (v.assetArchived) probs.push("the asset is archived");
    if (v.source === "imported" && v.assetStatus !== "approved") probs.push("the imported image is not approved yet");
    add({ id: `rights_${v.ratio}`, group: "rights", label: `Rights (${v.ratio})`, ...det, status: probs.length ? "fail" : "pass", ratio: v.ratio,
      message: probs.length ? `The ${v.ratio} image cannot be used: ${probs.join("; ")}.` : v.source === "generated" ? "Made in this studio; its source and model are recorded." : "Imported with a stated right to use it and an approved status.",
      ...(probs.length ? { repair: "Fix the asset in Brand → Assets (state its rights, renew the licence, get it approved), or use a different image." } : {}) });
  }

  // ---- accessibility
  const alt = i.altText.trim();
  add({ id: "alt_text", group: "accessibility", label: "Alt text", ...det, status: alt.length >= 10 && alt.length <= 300 ? "pass" : "fail",
    message: alt.length === 0 ? "There is no alt text describing the picture." : alt.length < 10 ? "The alt text is too short to describe the picture." : alt.length > 300 ? "The alt text is over 300 characters." : "The picture has alt text.",
    ...(alt.length >= 10 && alt.length <= 300 ? {} : { repair: "Describe what the picture shows in one or two sentences (10 to 300 characters)." }) });
  const cr = contrastRatio(k.palette.foreground, k.palette.background);
  add({ id: "contrast", group: "accessibility", label: "Text contrast", ...det, status: cr >= 4.5 ? "pass" : "fail", message: `Text colour against background is ${cr.toFixed(1)}:1 (needs 4.5:1).`, ...(cr >= 4.5 ? {} : { repair: "Choose a darker text colour or a lighter background (or the reverse)." }) });
  const ca = contrastRatio(k.palette.accent, k.palette.background);
  add({ id: "accent_contrast", group: "accessibility", label: "Accent contrast", ...det, status: ca >= 3 ? "pass" : "warn", message: `Accent colour against background is ${ca.toFixed(1)}:1 (3:1 is the minimum for graphics).`, ...(ca >= 3 ? {} : { repair: "Pick an accent that stands out more from the background." }) });
  add({ id: "text_in_image", group: "accessibility", label: "Words in the picture", ...det, status: "info", message: "Words drawn inside a picture cannot be read by a screen reader or checked here. Keep the important words in the headline and supporting line." });

  // ---- critique: not performed
  add({ id: "ai_critique", group: "critique", label: "AI-assisted critique", method: "ai_critique", status: "not_performed", message: "No AI critique was run. This release makes no AI image or critique calls, so nothing here says the picture is good, only that the automatic rules passed." });

  const counts = { pass: 0, fail: 0, warn: 0, info: 0, not_checked: 0, not_performed: 0 } as Record<QaStatus, number>;
  for (const c of checks) counts[c.status]++;
  const scored = counts.pass + counts.fail;
  return {
    checks, passed: counts.fail === 0, counts,
    score: { percent: scored ? Math.round((counts.pass / scored) * 100) : null, of: scored, note: "A review aid: the share of automatic checks that passed. It is not a prediction of results and not a substitute for a person's decision." },
  };
}
