import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const source = path.resolve(process.argv[2] ?? '');
if (!source) throw new Error('usage: node runtime-inventory-r2.mjs <fixed-source-root>');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const packages = [
  {name: '@earendil-works/pi-coding-agent', packageJson: 'node_modules/@earendil-works/pi-coding-agent/package.json', entry: 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'},
  {name: '@earendil-works/pi-ai', packageJson: 'node_modules/@earendil-works/pi-ai/package.json', entry: 'node_modules/@earendil-works/pi-ai/dist/compat.js'},
  {name: 'pi-hermes-memory', packageJson: 'packages/hermes-memory/package.json', entry: 'packages/hermes-memory/dist/index.js'},
  {name: 'better-sqlite3', packageJson: 'node_modules/better-sqlite3/package.json', entry: 'node_modules/better-sqlite3/lib/index.js', native: 'node_modules/better-sqlite3/prebuilds/win32-x64.node'},
  {name: '@pi-gui/pi-sdk-driver', packageJson: 'packages/pi-sdk-driver/package.json', entry: 'packages/pi-sdk-driver/dist/pi-sdk-driver.js'},
];
const packageInventory = packages.map(item => {
  const packagePath = path.join(source, item.packageJson);
  const entryPath = path.join(source, item.entry);
  const pkg = read(packagePath);
  const output = {name: item.name, version: pkg.version, license: pkg.license ?? null, packageJson: packagePath, packageJsonSha256: sha256(packagePath), entry: entryPath, entrySha256: sha256(entryPath)};
  if (item.native) {
    const nativePath = path.join(source, item.native);
    output.nativePrebuild = {path: nativePath, sha256: sha256(nativePath), bytes: fs.statSync(nativePath).size};
  }
  return output;
});
const rootPackage = read(path.join(source, 'package.json'));
const desktop = read(path.join(source, 'apps/desktop/package.json'));
const lockPath = path.join(source, 'pnpm-lock.yaml');
const result = {
  source,
  packageManager: rootPackage.packageManager,
  lock: {path: lockPath, sha256: sha256(lockPath)},
  runtime: {execPath: process.execPath, node: process.version, abi: process.versions.modules, napi: process.versions.napi, platform: process.platform, arch: process.arch},
  electron: {lockedManifestValue: desktop.devDependencies?.electron ?? desktop.dependencies?.electron ?? null, launched: false, note: 'GUI/Electron launch is prohibited by the S07A contract.'},
  packages: packageInventory,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
