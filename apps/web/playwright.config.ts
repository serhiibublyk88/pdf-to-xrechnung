import { defineConfig } from '@playwright/test';

const port = process.env.PLAYWRIGHT_PORT ?? '3100';
const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseURL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  webServer: externalBaseURL
    ? undefined
    : {
        command: `npm run dev -- -p ${port}`,
        url: `${baseURL}/de`,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        env: {
          API_ORIGIN: process.env.API_ORIGIN ?? 'http://localhost:3000',
        },
      },
});
