import { defineConfig, devices } from '@playwright/test'
import { STATE_FILE } from './e2e/helpers'

/**
 * End-to-end tests against the built reader and all three Workers in one `wrangler dev`, on fresh
 * local D1, R2 and queues. `e2e/run.sh` starts the stack and the fixture feed server; the global
 * setup signs a member in through the real code flow.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts/,
  globalSetup: './e2e/setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:8811',
    storageState: STATE_FILE,
    trace: 'retain-on-failure',
    locale: 'en-US',
    // The shell's service worker would answer navigations from its cache; specs measure the app.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      testMatch:
        /(local-first|reader|translation|highlights|info|invites|keyboard|layout|public|settings|signin|social|styles|visitor|websub|door|oauth)\.e2e\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    // The stacked layout below the desktop breakpoint. A Chromium device profile, so CI needs only
    // one browser download.
    { name: 'mobile', testMatch: /mobile\.e2e\.ts/, use: { ...devices['Pixel 7'] } },
  ],
})
