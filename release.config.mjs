import { execFileSync } from 'node:child_process';

// Sanitizes a `feature/*` branch name into a valid semver prerelease identifier
// (and npm dist-tag). Evaluated by semantic-release as a lodash template with
// the `name` variable bound to the full branch name (e.g. `feature/my-thing`).
const featureIdentifier =
  '${name.replace(/^feature\\//, "").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "alpha"}';

const tryGit = (...args) => {
  try {
    execFileSync('git', args, { stdio: 'ignore' });
  } catch {}
};

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
    '@semantic-release/npm',
    ...(isFeatureBranch ? [] : ['@semantic-release/github']),
    removeGitTagOnFeature,
  ],
};
