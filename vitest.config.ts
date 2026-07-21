import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@pokemon-splendor/game-core': new URL('./packages/game-core/src/index.ts', import.meta.url)
        .pathname,
      '@pokemon-splendor/game-data': new URL('./packages/game-data/src/index.ts', import.meta.url)
        .pathname,
      '@pokemon-splendor/protocol': new URL('./packages/protocol/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    environment: 'node',
    testTimeout: 40_000,
    include: ['apps/**/test/**/*.test.{js,ts}', 'packages/**/test/**/*.test.{js,ts}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      include: [
        'apps/server/src/file-room-store.ts',
        'apps/server/src/room-*.ts',
        'apps/web/src/net.ts',
        'packages/*/src/**/*.ts',
      ],
      exclude: ['**/*.d.ts'],
      thresholds: {
        statements: 74,
        branches: 66,
        functions: 83,
        lines: 79,
        'packages/protocol/src/**': {
          statements: 82,
          branches: 84,
          functions: 85,
          lines: 91,
        },
        'packages/game-core/src/engine.ts': {
          statements: 78,
          branches: 65,
          functions: 87,
          lines: 83,
        },
      },
    },
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
  },
});
