import { defineConfig } from 'vite-plus';

import tsdownConfig from './tsdown.config.js';

export default defineConfig({
  staged: { '*': 'vp check --fix' },
  pack: tsdownConfig,
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
