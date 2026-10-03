import { defineConfig } from 'tsup';

// Workspace packages (@ntrack/*) ship TypeScript source, so they are bundled into the output.
// Third-party dependencies (Prisma client, ioredis, ...) stay external and load from node_modules.
export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@ntrack\//],
  // Prisma's generated client must load from node_modules (native engine, CJS runtime).
  external: ['@prisma/client', '.prisma/client'],
});
