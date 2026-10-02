import { defineConfig } from 'vite-plus';

export default defineConfig({
  pack: {
    attw: true,
    deps: { onlyBundle: false, resolveDepSubpath: true },
    dts: { sourcemap: true },
    exports: { devExports: 'development', packageJson: true },
    platform: 'neutral',
    publint: true,
    sourcemap: true,
    unbundle: false,
  },
});
