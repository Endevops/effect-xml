import { defineConfig } from 'vite-plus';

// Workspace-root toolchain configuration.
//
// Oxlint and Oxfmt are configured here and only here. `vp lint`, `vp fmt`, and
// `vp check` read the root `lint` and `fmt` blocks even when invoked from a
// package directory, and Oxlint/Oxfmt ignore nested configs in Vite+ mode, so a
// package cannot drift from this file. Package-level `vite.config.ts` files
// are for per-package concerns only (currently just `pack`); anything a second
// package would also need belongs here, as a `lint.overrides` or `fmt.overrides`
// entry keyed on workspace globs such as `packages/<name>/**`.
export default defineConfig({
  staged: {
    '*': 'vp check --fix',
    '*.{js,ts,cjs,mjs,d.cts,d.mts,jsx,tsx}': ["sh -c 'exec fallow --changed-since HEAD --type-aware --fail-on-issues'"],
  },
  run: { cache: { scripts: true } },
  test: { isolate: false, fsModuleCache: true, coverage: { exclude: ['**/test/**'] } },
  fmt: {
    arrowParens: 'avoid',
    bracketSameLine: true,
    bracketSpacing: true,
    jsxSingleQuote: true,
    printWidth: 150,
    quoteProps: 'as-needed',
    semi: true,
    singleQuote: true,
    tabWidth: 2,
    trailingComma: 'es5',
    importOrderCaseSensitive: false,
    jsdoc: {
      commentLineStrategy: 'multiline',
      descriptionTag: true,
      preferCodeFences: true,
      separateReturnsFromParam: true,
      separateTagGroups: true,
      descriptionWithDot: true,
      keepUnparsableExampleIndent: false,
      capitalizeDescriptions: true,
    },
    htmlWhitespaceSensitivity: 'css',
    objectWrap: 'collapse',
    sortPackageJson: { sortScripts: true },
    sortImports: {
      newlinesBetween: true,
      sortSideEffects: true,
      groups: [
        'side_effect_style',
        'side_effect',
        'type-import',
        ['value-builtin', 'value-external'],
        'type-internal',
        'value-internal',
        ['type-parent', 'type-sibling', 'type-index'],
        ['value-parent', 'value-sibling', 'value-index'],
        'unknown',
      ],
    },
  },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
});
