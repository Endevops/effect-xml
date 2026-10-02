# effect-xml

A pnpm workspace for the Endevops XML packages, built on
[Vite+](https://viteplus.dev/guide/) for the toolchain.

| Package                                                     | Description                                               |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| [`@endevops/parser`](./packages/parser)                     | XML parser with pluggable output builders                 |
| [`@endevops/builder`](./packages/builder)                   | XML builders, the output-builder base and the compact one |
| [`@endevops/common-xml`](./packages/common-xml)             | Entity coding, path matching, XML name validation         |
| [`@endevops/effect-xml-codec`](./packages/effect-xml-codec) | Round-trip Effect Schema codec for XML                    |
| [`@endevops/benchmarks`](./packages/benchmarks)             | Private project that runs the benchmarks, never published |

Four publishable packages, in a strict chain: `common-xml` has no workspace
dependencies, `builder` depends on `common-xml`, `parser` depends on both, and
`effect-xml-codec` depends on `common-xml` with the other two for tests and
benchmarks. There is no cycle in that graph. `packages/benchmarks` is a fifth,
private project that depends on all four and ships nothing; it exists only to
run the benchmarks.

## Layout

```
packages/<name>/     publishable package: src/, test/, docs/, package.json
packages/benchmarks/ private benchmark project: bench/, never built or published
vite.config.ts       Oxlint, Oxfmt, staged checks — one config for the whole repo
tsconfig.shared.json compilerOptions every package extends
pnpm-workspace.yaml  package globs, version catalog, overrides
```

A package that absorbed several of the earlier ones keeps a subdirectory per
absorbed package, each with its own barrel, and re-exports all of them flat from
`src/index.ts`. `common-xml` is `src/entities/`, `src/naming/` and
`src/path-matcher/`; `builder` is `src/xml-builder/`, `src/output-builder/` and
`src/compact-builder/`. Specs sit under the matching `test/` subdirectory and
import from `#/index.ts` like any other module in the package. Nothing is exposed
per-area at the package boundary — one package, one entry point.

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
vp run bench         # the `*.bench.ts` benchmarks, no tests
pnpm build           # vp run -r build — pack every package
```

For one package, target it with `-C`, which behaves exactly like `cd`-ing there:

```bash
vp -C packages/parser check
vp -C packages/parser test
vp -C packages/parser pack
```

### Benchmarks

Benchmarks are [Vitest benchmarks](https://vitest.dev/guide/benchmarking.html), not scripts. A
file named `*.bench.ts` is collected by the benchmark project, which `vp test` skips entirely and
`vp test bench` runs on its own. Keeping them out of `vp test` is the point: they are slow and
noisy, and nothing about the suite should depend on a number that moves with the weather.

Benchmarks that drive a package's public entry point live in `packages/benchmarks`. It is
`private`, so `pnpm -r publish` skips it and it has no build step. It resolves each workspace
dependency to its built `dist/`, so run `pnpm build` before it, and the numbers describe what
consumers install. `packages/parser/bench/scan.bench.ts` measures parser internals that are not
exported, so it stays with the parser and runs from source.

`vp run bench` runs each package's `bench` script in its own project, so the two resolve
differently on purpose.

```bash
pnpm build                                    # the benchmark project reads dist/
vp run bench                                  # every benchmark
vp -C packages/benchmarks test bench          # the built-output benchmarks
vp -C packages/parser test bench              # the internal parser benchmarks
vp -C packages/parser test bench -t asciiOnly # one test name
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

Releases are automatic. `semantic-release` runs in CI on `master`, `develop`,
`feature/*` and `hotfix/*`, derives the next version from
[Conventional Commits](https://www.conventionalcommits.org), writes that one
version into the root manifest and every package manifest, and publishes every
package at it. See [docs/versioning.md](./docs/versioning.md) for the branches,
bump rules and channels.

`prepublishOnly` runs `vp pack` in each package, so `pnpm -r publish` builds
each package before it goes out. The root manifest is `private` and is never
published, and so is `packages/benchmarks`: `pnpm -r publish` skips both, and
`scripts/release/sync-versions.mjs` stamps only the publishable manifests, so a
private package never appears in a release commit.

## License

MIT. See [`packages/parser/LICENSE`](./packages/parser/LICENSE).
