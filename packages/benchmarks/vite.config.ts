import { defineConfig } from 'vite-plus';

// Per-project Vite+ configuration. The benchmark project ships no artifact, so
// there is no `pack` block here: it exists only so the benchmarks can be run
// from this directory. Lint, format and type-checking come from the workspace
// root config, which cannot be overridden here.
export default defineConfig({});
