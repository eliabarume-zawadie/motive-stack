/**
 * Structural limits for a parsed JSON request body, applied before any route validates it.
 *
 * Why: the installed zod 3 can use a lot of memory and time validating a very large array whose elements all fail (advisory GHSA-mrhx-c7xc-m3w5), and the 256 KB body limit still
 * allows about 128,000 elements. No legitimate request comes close to these limits: across the whole test suite (11,382 request bodies) the largest array was 40 elements and the
 * deepest nesting 5 levels; the largest accepted collection, a lead import, is capped at 200 rows by its own schema. The limits below are therefore 5x and 2.4x those maxima.
 *
 * This is an interim safeguard, not a fix: zod stays at 3.x until the planned migration to zod 4, which is required before any public launch.
 */
export const MAX_JSON_ARRAY_LENGTH = 200;
export const MAX_JSON_DEPTH = 12;

export type BodyShapeProblem = "array_too_long" | "too_deep";

/** Walks the value without recursion (so a hostile shape cannot overflow the stack) and stops at the first violation. Returns null when the shape is acceptable. */
export function bodyShapeProblem(value: unknown): BodyShapeProblem | null {
  if (value === null || typeof value !== "object") return null;
  const stack: Array<[object, number]> = [[value, 1]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (depth > MAX_JSON_DEPTH) return "too_deep";
    if (Array.isArray(node)) {
      if (node.length > MAX_JSON_ARRAY_LENGTH) return "array_too_long";
      for (const child of node) if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    } else {
      for (const child of Object.values(node)) if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  return null;
}
