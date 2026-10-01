import { defineConfig } from 'vite-plus';

// Per-package Vite+ configuration. Deliberately minimal: the workspace root
// vite.config.ts owns Oxlint, Oxfmt, staged checks and type-checking for the
// whole repo, and those settings cannot be overridden from here. What stays in
// a package config is what is genuinely specific to building that package —
// which today is only the tsdown packaging options.
export default defineConfig({
  pack: {
    attw: true,
    deps: { onlyBundle: false, resolveDepSubpath: true },
    dts: { sourcemap: true },
    exports: { devExports: 'development', packageJson: true },
    platform: 'neutral',
    publint: true,
    sourcemap: true,
    unbundle: true,
  },
});
