import { defineConfig } from 'vite-plus';

// Per-package Vite+ configuration. Deliberately minimal: the workspace root
// vite.config.ts owns Oxlint, Oxfmt, staged checks and type-checking for the
// whole repo, and those settings cannot be overridden from here. What stays in
// a package config is what is genuinely specific to building that package —
// which today is only the tsdown packaging options.
//
// `unbundle: true` keeps the emitted output mirroring src/ one file per module
// rather than collapsing six modules into a single chunk, so the published file
// layout and the source layout stay recognisably the same thing.
//
// `effect` is a peer dependency, so tsdown must not inline it. `deps.resolveDepSubpath`
// plus the default external handling leaves it alone; `dts: true` still resolves
// its types for the declaration files.
export default defineConfig({
  pack: {
    deps: { onlyBundle: false, resolveDepSubpath: true },
    dts: { sourcemap: true },
    exports: { devExports: 'development', packageJson: true },
    attw: true,
    publint: true,
    unbundle: true,
    platform: 'neutral',
    sourcemap: true,
  },
});
