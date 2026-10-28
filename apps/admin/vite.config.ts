/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The admin console is served by the landing Worker under /admin (see apps/landing/worker).
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  build: { sourcemap: false, target: 'es2022', outDir: 'dist' },
  server: { port: 5174, proxy: { '/admin/api': 'http://localhost:8788' } },
  test: { environment: 'jsdom', globals: true, include: ['src/**/*.test.{ts,tsx}'] },
});
