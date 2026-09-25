import { defineConfig } from 'vite-plus/pack';

export default defineConfig({
  deps: { resolveDepSubpath: true },
  dts: true,
  exports: true,
  // ...config options
});
