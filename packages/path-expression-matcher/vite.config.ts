import { defineConfig } from 'vite-plus';

// Per-package Vite+ configuration. Deliberately minimal: the workspace root
// vite.config.ts owns Oxlint, Oxfmt, staged checks and type-checking for the
// whole repo, and those settings cannot be overridden from here. What stays in
// a package config is what is genuinely specific to building that package —
// which today is only the tsdown packaging options.
//
// `unbundle: true` keeps the emitted output mirroring src/ one file per module
// rather than collapsing four modules into a single chunk, so the published
// file layout and the source layout stay recognisably the same thing.
export default defineConfig({ pack: { deps: { resolveDepSubpath: true }, dts: true, exports: true, unbundle: true } });
