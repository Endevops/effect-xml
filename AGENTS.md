<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Effect

This workspace uses [Effect](https://effect.website) 4, pinned in the `catalog`
in `pnpm-workspace.yaml` and currently on a release candidate. Before writing
Effect code, read `node_modules/effect/AGENTS.md` in full, and search
`node_modules/effect/src` for anything it does not cover.

Two things about this version are worth knowing before designing anything on
top of it, both found the hard way while building
`packages/effect-xml-codec`:

- **The schema derivations are internal.** `toCodecJson`, `toCodecIso` and
  `toCodecStringTree` walk a schema AST through `SchemaAST.replaceEncoding` and
  a per-node `recur` walker, both `/** @internal */` and stripped from the
  published `.d.ts`; `./internal/*` is not on the export map. A derivation of
  your own cannot reuse them, and casting over `effect/SchemaAST` to reach them
  pins a library to one patch release.
- **`Schema.decodeTo` declares its transformation getters backwards.** It types
  `decode` as `To.Encoded → From.Type` and `encode` as `From.Type →
To.Encoded`, and its implementation runs them the other way round. Every use
  inside Effect's own source is a target that is a `Declaration` or a primitive
  — where `Type` and `Encoded` coincide and the inversion is invisible — so
  composing two genuine codecs through it silently needs casts. `test/`
  behaviour, not the types, is what to trust here.

# Benchmarks

Benchmarks are Vitest benchmarks, not scripts. A file named `*.bench.ts` is
collected by the benchmark project, which `vp test` skips and `vp test bench`
runs alone.

- `vp run bench` — every benchmark in the workspace (`vp test bench` under the hood).
- `vp test bench packages/<name>` — one package. `vp test bench -t <name>` narrows by test name.
- `vp check` covers `bench/` like any other source: the package `tsconfig.json`
  already lists `bench/**/*.ts` in `include`, so a benchmark that stops
  type-checking fails the review checklist like anything else.

Two things the Vitest benchmarking guide warns about, both of which the existing
files already handle and any new one needs to:

- **A discarded result is a result the JIT may delete.** Fold it into a
  module-scope counter and read that back in `afterAll`, or the benchmark
  measures nothing and reports a very fast number.
- **Vitest 4's `BENCH Summary` ranks every benchmark in a suite against every
  other benchmark in that suite.** The summary is roughly
  `benchmark count - suite count` lines, so one suite per configuration, not one
  benchmark per combination.

Note the argument order: on the installed Vitest 4 it is
`bench(name, fn, options)`. Vitest 5 documents `bench(name, options, fn)` and
adds a `bench` test-context fixture; neither applies here.

# Git

- After a task runs and its checks pass, commit the work. Do not wait to be asked.
- Skip the commit when the user says not to commit, or when there is nothing worth committing (no file changes).
- Never push. Leave the commit on the current branch for the user to review.
- Before committing, review the diff and leave out unrelated changes, secrets, and generated noise.
- Write the subject in the imperative mood under 72 characters. Match the existing history (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`).
- One logical change per commit. Don't fold unrelated edits into a single commit.
- If a commit hook rewrites files (formatter, linter), re-stage and amend rather than starting a new commit.
