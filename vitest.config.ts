import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Heavy tests (full-server builds, website analysis, spawned CLIs) run several times slower when the whole suite runs in parallel on a busy machine, which made the 5 s default fail
    // intermittently (up to 12 timeouts in one run, each passing alone). 20 s keeps a hung test from waiting forever; no assertion or per-test timeout was weakened.
    testTimeout: 20000,
    // Blocks all outbound fetch during the default run and fails any file that attempts one.
    setupFiles: ["./test/setup.ts"],
  },
});
