import { defineConfig, devices } from '@playwright/test';

const PORT = 3108;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npx wrangler d1 migrations apply tickertracker-d1 --local && npx next dev --hostname 127.0.0.1 --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      SESSION_SECRET: 'test-session-secret-key-32b-long-abc',
      NEXT_PUBLIC_APP_URL: baseURL,
      // Exercise the real D1 path in e2e; the local database is migrated by the
      // command above and lives in .wrangler/state.
      AUTH_BACKEND: 'd1',
      MIGRATION_SECRET: 'test-migration-secret',
      // The suite registers accounts with @example.com, which the public
      // registration policy rejects. This flag is never set in production.
      E2E: '1',
    },
  },
});
