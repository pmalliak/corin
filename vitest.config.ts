import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The Worker's tests are the ones here. `voice/` is a separate workspace with
    // its own dependencies, and its tests run on Node's built-in runner, so
    // vitest picking them up finds no suite and fails the whole run.
    include: ["test/**/*.test.ts"],
  },
});
