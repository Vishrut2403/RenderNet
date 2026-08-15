import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the API is proxied so the browser sees a same-origin /api and CORS
// never comes into play. In production set VITE_API_URL to the backend origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 8080,
    proxy: {
      '/api': {
        target: process.env.VITE_PROXY_TARGET || 'http://localhost:5500',
        changeOrigin: true
      }
    }
  }
});
