import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Stamps one shared version into the root manifest and every package manifest.
// Invoked by semantic-release's `@semantic-release/exec` prepare step with the
// computed `nextRelease.version` as the only argument. See docs/versioning.md.

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`sync-versions: expected a semver version, received ${JSON.stringify(version)}`);
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifests = [join(root, 'package.json')];
const packagesDir = join(root, 'packages');

for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) {
    continue;
  }
  const manifest = join(packagesDir, entry.name, 'package.json');
  if (existsSync(manifest)) {
    manifests.push(manifest);
  }
}

// Replace only the first `"version": "..."` occurrence so the rest of the file,
// including its formatting, is left untouched.
const versionPattern = /("version"\s*:\s*")[^"]*(")/;

for (const manifest of manifests) {
  const text = readFileSync(manifest, 'utf8');
  const { name, version: current } = JSON.parse(text);
  if (current === version) {
    continue;
  }
  if (!versionPattern.test(text)) {
    console.error(`sync-versions: no version field in ${manifest}`);
    process.exit(1);
  }
  writeFileSync(manifest, text.replace(versionPattern, `$1${version}$2`));
  console.log(`sync-versions: ${name} ${current} -> ${version}`);
}
