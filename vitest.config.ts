import { defineConfig } from 'vitest/config';

// Capture and render tests share data/screenshots and a Chromium each; run files one at a time.
export default defineConfig({ test: { fileParallelism: false } });
