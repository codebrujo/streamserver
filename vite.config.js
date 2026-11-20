import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    // during development: `npm start` in one terminal, `npm run dev:web` in another
    proxy: { '/api': 'http://localhost:8090' },
  },
});
