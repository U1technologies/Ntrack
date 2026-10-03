import { defineConfig } from 'vitest/config';

// Integration tests need PostgreSQL and Redis (and the env from .env). Run: npm run test:integration
export default defineConfig({
  test: {
    include: ['apps/*/test/integration/**/*.int.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
