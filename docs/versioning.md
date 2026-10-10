# Versioning strategy

Semantic versioning driven by **Conventional Commits**, executed automatically
by [**semantic-release**](https://semantic-release.gitbook.io/semantic-release)
in CI. There is no manual version bumping.

## Model

- **One version for the whole workspace.** The root is the only release unit;
  every publishable package under `packages/` is stamped with the same version
  and published together. A change in any package releases all of them. The
  workspace publishes one package, `effect-xml-codec`, and
  consumes it as a single unit; `packages/benchmarks` is private and never
  released.
- **Version numbers** follow [SemVer 2.0.0](https://semver.org/):
  `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]`.
- **Version selection** is derived from commit messages. A commit that does not
  match a release rule triggers no release.
- **Tags** are created automatically as `vMAJOR.MINOR.PATCH` (e.g. `v1.2.3`) and
  are the only tags the repository uses. They are also the version ledger
  semantic-release reads on the next run, so they are never deleted.

## Branch -> channel mapping

| Branch      | Version channel                                       | Example              | npm dist-tag     |
| ----------- | ----------------------------------------------------- | -------------------- | ---------------- |
| `master`    | Stable release                                        | `1.2.3`              | `latest`         |
| `develop`   | Beta prerelease                                       | `1.2.3-beta.1`       | `beta`           |
| `feature/*` | Feature-name prerelease (npm-only, no GitHub Release) | `1.2.3-my-feature.1` | `<feature-name>` |
| `hotfix/*`  | Release-candidate prerelease                          | `1.2.3-rc.1`         | `rc`             |

The prerelease identifier (and npm dist-tag) for a `feature/*` branch is the
sanitized branch name after `feature/`: lowercased, with runs of characters
outside `[a-z0-9-]` collapsed to a single `-` and leading/trailing `-` stripped
(e.g. `feature/My_Cool thing` -> `my-cool-thing`). Keep feature branch names to
lowercase alphanumerics and dashes. Two branches that sanitize to the same
identifier will conflict. If sanitization yields an empty string it falls back to
`alpha`.

Stable releases happen **only** on `master`. Prerelease channels never touch
`latest`. Work that lands on a prerelease branch is re-analyzed when merged into
`master`, so the same commits can produce `1.2.3-beta.1` on `develop` and then
`1.2.3` on `master`.

## Version bump rules

Applied from the **most significant** commit since the last release.

| Commit message                                                                | Bump       | Example result     |
| ----------------------------------------------------------------------------- | ---------- | ------------------ |
| `feat!:` / `fix!:` / `BREAKING CHANGE:` footer                                | MAJOR      | `1.2.3` -> `2.0.0` |
| `feat:`                                                                       | MINOR      | `1.2.3` -> `1.3.0` |
| `fix:`, `perf:`                                                               | PATCH      | `1.2.3` -> `1.2.4` |
| `build:`, `chore:`, `ci:`, `docs:`, `refactor:`, `revert:`, `style:`, `test:` | no release | -                  |

`refactor:`, `style:` and `docs: README` are configured as patch releases in
`release.config.mjs`.

Breaking changes are expressed either with an `!` after the type (`feat!:`) or
with a `BREAKING CHANGE:` trailer in the commit body.

**First release:** the repository has no tags yet and the packages are at
`0.0.0`. The first release is computed from existing history and lands as
`1.0.0`, which is above the currently published versions.

## What CI does

`.github/workflows/ci.yml`:

1. **`build-test`** runs on every push and pull request, in order:
   `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, `pnpm lint`.
2. **`release`** runs after a successful `build-test`, on pushes only. It runs
   `semantic-release`, which:
   - analyzes commits since the last tag,
   - computes the next version per the rules above,
   - writes that version into the root `package.json` and every publishable
     `packages/*/package.json` (`scripts/release/sync-versions.mjs`), commits
     the bump with `@semantic-release/git`, and tags it `vX.Y.Z`,
   - publishes every public package at that version with `pnpm -r publish`,
     which resolves `workspace:` and `catalog:` ranges and honors
     `publishConfig`,
   - publishes with OIDC **trusted publishing** and **provenance** (no
     `NPM_TOKEN` secret; the job carries `id-token: write`),
   - opens a GitHub Release with the generated changelog, except on `feature/*`,
     where only the npm dist-tag is updated.

If no release-worthy commit exists, `semantic-release` exits without releasing.

## Manual operations

| Goal                      | How                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cut a patch release       | Commit `fix:` on `master` (or merge a PR with one) and push.                                                                                                          |
| Cut a minor release       | Commit `feat:` on `master` and push.                                                                                                                                  |
| Cut a major release       | Commit with `BREAKING CHANGE:` / `feat!:` on `master` and push.                                                                                                       |
| Release a beta            | Push to `develop`.                                                                                                                                                    |
| Release a feature preview | Push to a `feature/*` branch. Publishes `x.y.z-<feature-name>.n` to npm under the `<feature-name>` dist-tag and tags the release commit, but opens no GitHub Release. |
| Publish no version        | Use `chore:`, `ci:`, `test:`, etc.                                                                                                                                    |

Do **not** tag releases by hand. `v*` tags created manually bypass the changelog
and provenance flow and confuse the next analysis.

## Configuration files

| File                                | Purpose                                             |
| ----------------------------------- | --------------------------------------------------- |
| `release.config.mjs`                | Branch -> channel mapping and plugin list           |
| `scripts/release/sync-versions.mjs` | Stamps the shared version into every manifest       |
| `.github/workflows/ci.yml`          | Build/test gate + `release` job                     |
| `package.json`                      | `semantic-release` and plugins in `devDependencies` |

## Prerequisites

- **Trusted publishing.** Each package must be configured for npm trusted
  publishing: on npmjs.com, add this repository and the `CI` workflow to the
  package's trusted publisher list. Until that is done, the publish step fails
  to authenticate.
- **Bot push access.** The release job commits the version bump back to the
  release branch (the `@semantic-release/git` plugin). On `master`, let
  `github-actions` bypass any "require a pull request" branch protection rule.
  Otherwise the push fails and the release aborts before anything is published.
  To skip the commit entirely, drop the `@semantic-release/git` entry from
  `release.config.mjs`; version numbers then live only in the published
  artifacts.

## Related

- [Conventional Commits specification](https://www.conventionalcommits.org)
- [semantic-release docs](https://semantic-release.gitbook.io/semantic-release)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
