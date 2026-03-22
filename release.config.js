module.exports = {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    ['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md' }],
    ['@semantic-release/exec', {
      prepareCmd: 'node scripts/prepare-release.js ${nextRelease.version}',
      publishCmd: 'node scripts/publish-release.js',
    }],
    ['@semantic-release/github'],
    ['@semantic-release/git', {
      assets: ['package.json', 'packages/core/package.json', 'packages/cli/package.json', 'CHANGELOG.md'],
      message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
    }],
  ],
};
