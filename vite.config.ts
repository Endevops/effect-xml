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
  staged: { '*': 'vp check --fix' },
  run: { cache: { scripts: true } },
  test: {
    // Every spec is a pure function of its input — no `vi.mock`, no fake timers, no global stubbing — so
    // reusing a worker across files buys back the ~300ms spawn each file costs without changing what any of
    // them observes. This is only safe while no spec leaves global state behind; `html.spec.ts`,
    // `j2x.spec.ts` and `j2x-ordered.spec.ts` restore the `Object.prototype` key they pollute for exactly
    // that reason. Run `vp test --isolate` to reproduce the old per-file isolation when a spec does leak.
    isolate: false,
    // The suite is 71 files of TypeScript with no bundler step, so transform dominated the run. Persisting
    // transformed modules on disk makes every run after the first skip it.
    fsModuleCache: true,
  },
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
