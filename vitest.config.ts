import { defineConfig } from 'vitest/config';

// Capture and render tests share data/screenshots and a Chromium each: run files one at a
// time, and give setup hooks that capture fixture sites room to finish.
export default defineConfig({ test: { fileParallelism: false, hookTimeout: 60_000, setupFiles: ['tests/setup.ts'] } });
