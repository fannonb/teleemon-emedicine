import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Never expose worker/service client secrets or OpenAI keys through broad env prefixes.
  envPrefix: ['MEDPLUM_BASE_URL', 'MEDPLUM_CLIENT_ID', 'MEDPLUM_PROJECT_ID', 'TELEEMON_ERX_MODE', 'VITE_PORTAL_URL'],
  plugins: [react()],
  // Workspace packages and lazy clinical pages must share the renderer's React instance.
  resolve: { dedupe: ['react', 'react-dom', '@medplum/react', '@medplum/react-hooks'] },
  optimizeDeps: {
    // Discover these together at startup rather than introducing a second prebundle when
    // a lazy route first imports Medplum hooks after a dev-server update.
    include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', '@medplum/react', '@medplum/react-hooks'],
  },
  build: { assetsInlineLimit: 0 }, // AudioWorklet must remain a same-origin module, not a data URL.
  server: {
    host: 'localhost',
    port: 3100,
    strictPort: true,
    proxy: { '/api/scribe': { target: 'http://127.0.0.1:3111', changeOrigin: false }, '/api/ledger': { target: 'http://127.0.0.1:3130', changeOrigin: false } },
    // Editors and code tools can briefly truncate files while saving on Windows.
    // Transform only the completed write so importers never cache an empty module.
    watch: { awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 } },
  },
  preview: { host: 'localhost', port: 3100, strictPort: true },
});
