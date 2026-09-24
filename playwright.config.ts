import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests-web",
  testMatch: "**/browser.spec.ts",
  workers: 1,
  outputDir: "test-results/browser-artifacts",
  timeout: 60000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:8788",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.PW_CHROMIUM_CHANNEL,
        viewport: { width: 1440, height: 1050 },
      },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], channel: process.env.PW_CHROMIUM_CHANNEL },
    },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: "http://127.0.0.1:8788/api/auth/config",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
