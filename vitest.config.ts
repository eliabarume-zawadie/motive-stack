import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Blocks all outbound fetch during the default run and fails any file that attempts one.
    setupFiles: ["./test/setup.ts"],
  },
});
