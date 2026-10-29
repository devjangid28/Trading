/// <reference types="vite/client" />

// Enables `import.meta.env` typing (DEV/PROD) without adding `vite/client` to
// the whole-project `types` list.

interface Window {
  /**
   * Set by `main.tsx` once the app entry has executed. Read by the boot
   * fallback in `index.html` so a slow or failed module load shows a message
   * instead of a blank page.
   */
  __ofBooted?: boolean;
}
