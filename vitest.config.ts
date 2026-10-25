import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['conformance/**/*.test.ts'], testTimeout: 20000, fileParallelism: false } });
