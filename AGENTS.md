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
- **`bench` is a test-context fixture, not an import.** Vite+ 1.0 bundles
  Vitest 5, which dropped the top-level `bench` the v4 files imported. A
  benchmark is a `test` that takes `bench` off its context and registers its
  workloads inside:

  ```ts
  test('encoding — a small document', async ({ bench }) => {
    await bench.compare(bench('this codec', measure(...)), bench('fast-xml-builder', measure(...)), BUDGET);
  });
  ```

  One `test` per configuration, with `bench.compare` over the workloads in it,
  so the printed table is the comparison and the fastest row is marked; a
  single workload calls `bench(name, fn).run(BUDGET)` instead. `BUDGET` — the
  sample and warmup window — moved with the rest: `time` and `warmupTime` are
  run options in v5, handed to `run` or `compare`, not to `bench` itself. A
  benchmark option that moved without being noticed is a silently changed
  measurement, so check the durations after a Vite+ upgrade rather than
  assuming the numbers mean what they meant.

A third thing the guide does not warn about, and the one that actually bit:

- **A benchmark is a `test`, and a `test` has a 60s timeout.** Tinybench runs a
  task until either `time` elapses _or_ `iterations` samples are collected —
  whichever comes last — and its defaults are `time: 1000` with
  `iterations: 64`. A workload heavy enough to outrun the time window (a
  full-document parse of a large fixture, say) is therefore run 64 times
  regardless, and 64 samples of a one-second task is a minute of work in a
  suite that cannot exceed 60. The fix is to pin `iterations` on any suite
  whose single iteration is not tens of microseconds — `iterations: 3` samples
  a slow task three times, and a longer `time` window still smooths the sample.
  `parse.bench.ts` carries the full note.

# Git

- After a task runs and its checks pass, commit the work. Do not wait to be asked.
- Skip the commit when the user says not to commit, or when there is nothing worth committing (no file changes).
- Never push. Leave the commit on the current branch for the user to review.
- Before committing, review the diff and leave out unrelated changes, secrets, and generated noise.
- One logical change per commit. Don't fold unrelated edits into a single commit.
- If a commit hook rewrites files (formatter, linter), re-stage and amend rather than starting a new commit.

## Commit messages

Every commit message follows [Conventional Commits](https://www.conventionalcommits.org/)
with the [Angular convention](https://github.com/angular/angular/blob/main/contributing-docs/commit-message-guidelines.md).
The subject and any scope are lowercase, the subject is imperative and under 72
characters, and no line in the body exceeds 100 characters.

```
<type>(<scope>): <subject>

<body>

<footer(s)>
```

- **`type`** — one of `feat`, `fix`, `perf`, `refactor`, `docs`, `style`, `test`,
  `build`, `ci`, `chore`. Use `docs` for documentation-only changes, `chore` for
  things that touch no source or tests (tooling, dependencies, generated files).
- **`scope`** — optional, but include it when the change is confined to one
  package or area: `refactor(builder): make XMLBuilder an Effect service`,
  `perf(effect-xml-codec): resolve names without an Effect per call`. Omit it for
  workspace-wide changes.
- **`subject`** — imperative mood, no leading capital, no trailing period. "add",
  not "added" or "adds".
- **`body`** — optional. Separate it from the subject with one blank line, and
  explain what and why rather than repeating the diff.
- **`footer`** — optional. Reference issues (`Refs #123`) or note a breaking
  change.
- **Breaking changes** — mark them with `!` after the type or scope
  (`feat(api)!: drop the legacy parse entry point`) and add a
  `BREAKING CHANGE: <description>` footer.
- Match the existing history: `refactor(parser): make XMLParser an Effect service`,
  `fix(parser): stop the parse benchmarks timing out`, and
  `docs: record the effect-services refactor progress`.
