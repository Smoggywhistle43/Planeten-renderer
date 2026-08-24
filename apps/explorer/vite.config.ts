import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: 5173 },
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
