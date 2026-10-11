import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

/**
 * Live integration tests. These hit Binance, so they are deliberately NOT in
 * `npm run verify` — that command stays fast and deterministic.
 *
 *   npm run test:integration
 */

function resolveTsFromJs() {
  return {
    name: 'orderflow:resolve-ts-from-js',
    enforce: 'pre' as const,
    resolveId(source: string, importer?: string) {
      if (source.startsWith('node:')) return { id: source, external: true };
      if (!importer || !source.startsWith('.') || !source.endsWith('.js')) return null;
      const base = resolvePath(dirname(importer), source.replace(/\.js$/, '.ts'));
      if (existsSync(base)) return base;
      const idx = base.replace(/\.ts$/, '/index.ts');
      if (existsSync(idx)) return idx;
      return null;
    },
  };
}

export default defineConfig({
  plugins: [resolveTsFromJs()],
  test: {
    environment: 'node',
    include: ['server/test/**/*.live.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 200_000,
    hookTimeout: 200_000,
  },
});
