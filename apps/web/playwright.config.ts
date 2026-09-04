import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests run against a built app. `e2e/run.sh` starts the local database, the
 * fixture feed server, the worker, and `next start`, then invokes Playwright with E2E_BASE_URL.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3999',
    trace: 'retain-on-failure',
    locale: 'en-US',
  },
  projects: [
    { name: 'chromium', testMatch: /reader\.e2e\.ts/, use: { ...devices['Desktop Chrome'] } },
    // The stacked fallback below the desktop breakpoint: list → article as a page. A Chromium
    // device profile so CI needs only one browser download.
    { name: 'mobile', testMatch: /mobile\.e2e\.ts/, use: { ...devices['Pixel 7'] } },
  ],
})
