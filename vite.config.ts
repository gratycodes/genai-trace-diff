/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves the app from /genai-trace-diff/. Override with BASE_PATH=/ for other hosts.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/genai-trace-diff/',
  plugins: [react()],
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
