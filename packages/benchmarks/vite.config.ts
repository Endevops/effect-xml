import { defineConfig } from 'vite-plus';

export default defineConfig({ test: { benchmark: { retainSamples: true } } });
