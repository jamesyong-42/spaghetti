const { execSync } = require('child_process');
const opts = { stdio: 'inherit' };

console.log('Building all packages...');
execSync('pnpm build', opts);

console.log('Publishing @vibecook/spaghetti-core...');
execSync('cd packages/core && npm publish --access public --provenance', opts);

console.log('Publishing @vibecook/spaghetti...');
execSync('cd packages/cli && npm publish --access public --provenance', opts);

console.log('Published successfully.');
