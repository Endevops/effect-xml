Pre release

- [ ] `vp check` clean, and `vp test` green
- [ ] `vp pack` builds and emits declarations
- [ ] No local package installation (`pnpm why --depth 0` on the runtime deps)
- [ ] Change log has been updated
- [ ] Added/updated documentation for new properties/features
- [ ] `pnpm-lock.yaml` reflects the right version : `pnpm install`
- [ ] Types are regenerated and correct for the ESM-only build
  - `dist/index.d.mts` is emitted by `vp pack`, never edited by hand
  - `test/public-api-surface.spec.ts` still passes; it holds the entry point to its documented exports
  - https://www.typescriptlang.org/play/
  - a scratch install of the tarball type-checks a consumer that imports the public names
- [ ] ReadMe file or docs are updated for any change, user list, performance report, links etc.
- [ ] Single test is not running `fit`
- [ ] `npm pack --dry-run` lists what you expect (LICENSE, README.md and dist/ only)
- [ ] tags are assigned to latest commit `git tag -a v0.1.0 -m "..."`

In general

- [ ] tests are added/updated

Post release

- [ ] `git push origin master --tags`
- [ ] Tagged and Released on github
- [ ] Notified to the users

To remove tag
git tag -d <tag_name>
