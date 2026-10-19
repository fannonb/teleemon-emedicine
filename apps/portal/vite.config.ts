import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  // Only the Medplum address, project and public portal client reach the browser.
  envPrefix: ['MEDPLUM_BASE_URL', 'MEDPLUM_CLIENT_ID', 'MEDPLUM_PROJECT_ID'],
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom', '@medplum/react-hooks'] },
  server: {
    host: 'localhost',
    port: 3200,
    strictPort: true,
    // The portal service is same-origin through this proxy (and the load balancer when deployed).
    proxy: { '/api/portal': { target: 'http://127.0.0.1:3120', changeOrigin: false } },
    watch: { awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 } },
  },
  preview: { host: 'localhost', port: 3200, strictPort: true, proxy: { '/api/portal': { target: 'http://127.0.0.1:3120', changeOrigin: false } } },
});
