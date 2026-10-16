import { afterAll } from "vitest";

/**
 * The default test run must never reach the internet. This replaces global fetch with a stub that throws and
 * counts, and fails the test file if anything tried. Tests that exercise the real SDKs pass their own mocked
 * `fetch`, so they are unaffected. Opt-in live tests set LIVE_TESTS=1 and keep the real fetch.
 */
let blocked = 0;
const live = process.env.LIVE_TESTS === "1";
const realFetch = globalThis.fetch;

if (!live) {
  globalThis.fetch = (async (input: unknown) => {
    blocked++;
    throw new Error(`NETWORK BLOCKED in tests: ${String((input as { url?: string })?.url ?? input)}`);
  }) as typeof fetch;
}

afterAll(() => {
  globalThis.fetch = realFetch;
  if (blocked > 0) throw new Error(`${blocked} outbound network request(s) were attempted during the default test run`);
});
