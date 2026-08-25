import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The palettes are project data, not application assets, so they live at the
 * repository root and get served from there. Anything dropped into `paletten/`
 * is reachable at `/<name>.json` — which is what `?palette=` takes.
 */
const PALETTES = fileURLToPath(new URL('../../paletten', import.meta.url));

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173 },
  publicDir: PALETTES,
  // The workspace packages publish TypeScript source rather than a build, so
  // Vite has to compile them instead of pre-bundling them as dependencies.
  optimizeDeps: {
    exclude: ['@planet/core', '@planet/field', '@planet/render'],
  },
  build: {
    target: 'esnext',
    sourcemap: true,
  },
});
