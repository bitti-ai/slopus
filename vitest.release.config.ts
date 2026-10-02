import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/release/**/*.test.ts"],
    environment: "node",
    testTimeout: 50_000,
    maxConcurrency: 3,
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
