/**
 * Shim for `node:sqlite`.
 *
 * Vitest's Vite pipeline strips the `node:` prefix and then tries to resolve
 * `sqlite` as an npm package, which fails. Routing it through
 * `createRequire` loads the real builtin at runtime and keeps Vite out of it.
 *
 * This is a test-harness concern only. The application imports `node:sqlite`
 * directly and runs on plain Node.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sqlite = require('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
export const StatementSync = sqlite.StatementSync;
export default sqlite;
