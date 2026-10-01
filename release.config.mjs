import { execFileSync } from 'node:child_process';

// One version for the whole workspace. A single semantic-release run at the
// root computes the next version from the repository's commits, stamps it into
// the root manifest and every package manifest, then publishes every package at
// that shared version. Full strategy: see docs/versioning.md.

// Sanitizes a `feature/*` branch name into a valid semver prerelease identifier
// (and npm dist-tag). Evaluated by semantic-release as a lodash template with
// the `name` variable bound to the full branch name (e.g. `feature/my-thing`).
const featureIdentifier =
  '${name.replace(/^feature\\//, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "alpha"}';

// Best-effort git: deleting an already-absent tag is expected, so swallow the
// failure rather than aborting an otherwise successful release.
const tryGit = (...args) => {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
  } catch {
    // Tag may not exist locally or remotely; the release itself succeeded.
  }
};

// Feature/* releases are npm-only: semantic-release always creates a git tag,
// so delete it (local + remote) right after a successful feature release.
// The matching `@semantic-release/github` exclusion below avoids leaving a
// GitHub Release behind that points at the deleted tag.
const removeGitTagOnFeature = {
  async success(_pluginConfig, context) {
    const branchName = context.branch.name;
    if (!branchName.startsWith('feature/')) {
      return;
    }
    const tag = `v${context.nextRelease.version}`;
    tryGit('tag', '-d', tag);
    tryGit('push', 'origin', `:refs/tags/${tag}`);
    context.logger.log(`Deleted git tag ${tag} (feature branch releases are npm-only).`);
  },
};

// In CI the release job runs on push, so GITHUB_REF_NAME holds the branch name.
// Feature branches publish to npm only, with no GitHub Release (which requires
// a git tag).
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
        // Stamp the shared version into the root and every package manifest
        // before the release commit and the publish run.
        prepareCmd: 'node scripts/release/sync-versions.mjs ${nextRelease.version}',
        // Publish every workspace package at the shared version. pnpm resolves
        // each `workspace:^` range to the matching published version and
        // publishes in dependency order.
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
    removeGitTagOnFeature,
  ],
};
