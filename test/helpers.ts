import { vi } from "vitest";

export type Call = { url: string; init: RequestInit };

/** Build a fetch mock that returns the queued responses in order and records every call. */
export function mockFetch(responses: Array<{ status?: number; body?: unknown } | Error>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("mockFetch: no more queued responses");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls, fn };
}

export const noSleep = async () => {};

export function graphError(code: number, message = "boom", extra: Record<string, unknown> = {}) {
  return { error: { message, type: "OAuthException", code, fbtrace_id: "TRACE", ...extra } };
}
