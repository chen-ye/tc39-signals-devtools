import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    viewport: { width: 1280, height: 800 },
  },
});
