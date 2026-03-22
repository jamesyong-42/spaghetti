const fs = require('fs');
const version = process.argv[2];

// Update version in all package.json files
for (const p of ['package.json', 'packages/core/package.json', 'packages/cli/package.json']) {
  const pkg = JSON.parse(fs.readFileSync(p, 'utf-8'));
  pkg.version = version;
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
}

// Replace workspace:* with actual version in CLI's dependency on core
const cliPkg = JSON.parse(fs.readFileSync('packages/cli/package.json', 'utf-8'));
if (cliPkg.dependencies && cliPkg.dependencies['@spaghetti/core'] === 'workspace:*') {
  cliPkg.dependencies['@spaghetti/core'] = version;
  fs.writeFileSync('packages/cli/package.json', JSON.stringify(cliPkg, null, 2) + '\n');
}

console.log(`Prepared release v${version}`);
