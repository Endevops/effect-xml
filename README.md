# effect-xml

A pnpm workspace for the Endevops XML packages. One library today, built on
[Vite+](https://viteplus.dev/guide/) for the toolchain.

| Package                                                                   | Description                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------- |
| [`@endevops/flexible-xml-parser-effect`](./packages/parser)               | XML parser with pluggable output builders               |
| [`@endevops/path-expression-matcher`](./packages/path-expression-matcher) | Path tracking and pattern matching for XML/JSON parsers |
| [`@endevops/xml-naming`](./packages/xml-naming)                           | Validates XML name productions                          |
| [`@endevops/xml-builder`](./packages/builder)                             | Builds XML from a JavaScript object                     |
| [`@endevops/base-output-builder`](./packages/base-output-builder)         | Base classes and value-parser primitives for builders   |
| [`@endevops/entities`](./packages/entities)                               | XML and HTML entity encoding and decoding               |
| [`@endevops/compact-builder`](./packages/compact-builder)                 | Builds a compact JS object from XML                     |

## Layout

```
packages/<name>/     publishable package: src/, test/, docs/, package.json
vite.config.ts       Oxlint, Oxfmt, staged checks — one config for the whole repo
tsconfig.shared.json compilerOptions every package extends
pnpm-workspace.yaml  package globs, version catalog, overrides
```

`vp lint`, `vp fmt`, and `vp check` read the `lint` and `fmt` blocks in the root
`vite.config.ts` even when you run them from inside a package, and Oxlint and
Oxfmt ignore nested configs in Vite+ mode. That is deliberate: a package cannot
quietly opt out of the shared lint and format rules. When one package needs
different settings, add a `lint.overrides` or `fmt.overrides` entry keyed on
`packages/<name>/**` rather than a config file in the package.

A package's own `vite.config.ts` holds only what is specific to that package —
here, the tsdown `pack` options. The root config has no `pack` block, because
`vp pack` at the root needs a target and would otherwise be ambiguous.

## Commands

Run from the workspace root:

```bash
vp install           # install, via the packageManager field
vp check             # format, lint, type-check — every package
vp test              # every package's test suite
pnpm build           # vp run -r build — pack every package
```

For one package, target it with `-C`, which behaves exactly like `cd`-ing there:

```bash
vp -C packages/parser check
vp -C packages/parser test
vp -C packages/parser pack
```

A bare `vp pack` at the root refuses to guess between the root and the packages
and prints the commands to use instead. That is the intended behaviour once
more than one package exists.

## Adding a package

1. `mkdir -p packages/<name>` with its own `package.json`, and declare it in
   `pnpm-workspace.yaml` if the name does not match `packages/*`.
2. Add a `tsconfig.json` that extends `../../tsconfig.shared.json`. Keep `paths`
   and `include` there, not in the shared file — both resolve relative to the
   file that declares them, so a `paths` entry in the shared file would anchor
   to the root.
3. Take shared dependency versions from the `catalog` in `pnpm-workspace.yaml`
   with `"<dep>": "catalog:"`, so one edit updates every package.
4. Add a `pack` block to the package's `vite.config.ts` if it ships a build.
   Leave lint and format settings alone.

## Publishing

`prepublishOnly` runs `vp pack` in the package, so `pnpm -r publish` builds each
package before it goes out. The root manifest is `private` and is never
published.

## License

MIT. See [`packages/parser/LICENSE`](./packages/parser/LICENSE).
