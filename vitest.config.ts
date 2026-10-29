import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests, the offline red-team regression suites (test/redteam/*.redteam.test.ts) and the
    // env-gated live suites (skipped without credentials). test/redteam/live-exploit.ts is a manual
    // attack driver that writes to a live FreeScout, not a test: never collect it.
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**", "test/redteam/live-exploit.ts"],
  },
});
