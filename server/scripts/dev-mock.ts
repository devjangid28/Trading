/**
 * `npm run dev:mock` entry point.
 *
 * Sets the flag then imports the real server, so mock mode is the production
 * process with one environment variable set — not a fork of the server. That is
 * the whole point: if mock mode ran different code, a screen built in mock mode
 * would prove nothing about production.
 *
 * A wrapper script rather than `ORDERFLOW_MOCK=1 tsx ...` because the inline
 * env-var form does not work the same way on Windows cmd and PowerShell.
 */
process.env.ORDERFLOW_MOCK = '1';

console.log('[orderflow] starting in MOCK MODE — fixtures only, no outbound network');

await import('../src/index.js');