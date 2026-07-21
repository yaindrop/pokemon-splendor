import { defineConfig } from '@playwright/test';
import { env } from 'node:process';

const isCi = env['CI'] !== undefined;

export default defineConfig({
  testDir: './apps/web/e2e',
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  reporter: isCi ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:49732',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command:
        'HOST=127.0.0.1 PORT=49731 DATA_DIR=/tmp/pokemon-splendor-playwright-rooms PUBLIC_ORIGIN=http://127.0.0.1:49732 pnpm --filter @pokemon-splendor/server dev',
      url: 'http://127.0.0.1:49731/readyz',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command:
        'GAME_SERVER_URL=http://127.0.0.1:49731 pnpm --filter @pokemon-splendor/web dev --host 127.0.0.1 --port 49732',
      url: 'http://127.0.0.1:49732',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 980 } } },
    { name: 'narrow', use: { viewport: { width: 1180, height: 820 } } },
  ],
});
