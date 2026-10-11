import { defineConfig, type Plugin } from 'vitest/config';
import { existsSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The codebase uses `.js` extensions in relative imports (correct for NodeNext
 * ESM). Vite does not map those back to `.ts` on its own, so this plugin
 * rewrites a relative `...js` specifier to the `.ts` file that actually exists.
 */
function resolveTsFromJs(): Plugin {
  return {
    name: 'orderflow:resolve-ts-from-js',
    enforce: 'pre',
    resolveId(source, importer) {
      // Node builtins must stay external. `node:sqlite` in particular is a
      // runtime builtin, not an installable package, so Vite must not try to
      // resolve it into the module graph.
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
  resolve: {
    alias: {
      // Vitest strips `node:` and then tries to resolve `sqlite` as a package.
      // Route it through a shim that loads the builtin with createRequire.
      'node:sqlite': resolvePath(__dirname, 'server/test/node-sqlite-shim.mjs'),
    },
  },
  test: {
    environment: 'node',
    include: ['server/test/**/*.test.ts'],
    // `*.live.test.ts` needs network and is excluded from the default run so
    // `npm run verify` stays fast and deterministic.
    exclude: ['**/node_modules/**', '**/*.live.test.ts'],
    globals: false,
  },
});
