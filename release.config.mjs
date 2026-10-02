// Sanitizes a `feature/*` branch name into a valid semver prerelease identifier
// (and npm dist-tag). Evaluated by semantic-release as a lodash template with
// the `name` variable bound to the full branch name (e.g. `feature/my-thing`).
const featureIdentifier =
  '${name.replace(/^feature\\//, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "alpha"}';

// In CI the release job runs on push, so GITHUB_REF_NAME holds the branch name.
// Feature branches publish to npm only, with no GitHub Release. The git tag is
// still created: semantic-release reads it on the next run to advance the
// prerelease counter, so deleting it would republish the same version.
const isFeatureBranch = (process.env.GITHUB_REF_NAME ?? '').startsWith('feature/');

/**
 * @type {import('semantic-release').GlobalConfig}
 */
export default {
  branches: [
    'master',
    { name: 'develop', prerelease: 'beta' },
    { name: 'feature/*', prerelease: featureIdentifier, channel: featureIdentifier },
    { name: 'hotfix/*', prerelease: 'rc' },
  ],
  tagFormat: 'v${version}',
  plugins: [
    [
      '@semantic-release/commit-analyzer',
      {
        preset: 'angular',
        releaseRules: [
          { type: 'docs', scope: 'README', release: 'patch' },
          { type: 'refactor', release: 'patch' },
          { type: 'style', release: 'patch' },
        ],
        parserOpts: { noteKeywords: ['BREAKING CHANGE', 'BREAKING CHANGES'] },
      },
    ],
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/exec',
      {
        // Stamp the shared version into the root manifest and every publishable
        // package before the release commit and the publish run. A helper
        // script, not a plugin: it rewrites the `version` field in place and
        // leaves the rest of each manifest untouched.
        prepareCmd: 'node scripts/release/sync-versions.mjs ${nextRelease.version}',
        // Publish every workspace package at the shared version. pnpm resolves
        // `workspace:` and `catalog:` ranges, honors publishConfig (including
        // the `exports` override), and publishes in dependency order.
        publishCmd: 'pnpm -r publish --no-git-checks --access public --provenance --tag ${nextRelease.channel || "latest"}',
      },
    ],
    [
      '@semantic-release/git',
      {
        // Keep the committed manifests in lockstep with what npm receives.
        assets: ['package.json', 'packages/*/package.json'],
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
    ...(isFeatureBranch ? [] : ['@semantic-release/github']),
  ],
};
