import { defineConfig } from 'vite-plus';

// Per-package Vite+ configuration. Deliberately minimal: the workspace root
// vite.config.ts owns Oxlint, Oxfmt, staged checks and type-checking for the
// whole repo, and those settings cannot be overridden from here. What stays in
// a package config is what is genuinely specific to building that package —
// which today is only the tsdown packaging options.
//
// `unbundle` is absent here, unlike the multi-module packages: this one has a
// single entry module, so preserving its file layout and inlining it produce
// identical output.
export default defineConfig({ pack: { deps: { resolveDepSubpath: true }, dts: true, exports: true } });
