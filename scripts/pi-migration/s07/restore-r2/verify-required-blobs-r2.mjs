import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';

const [storeArg, sourceArg] = process.argv.slice(2);
if (!storeArg || !sourceArg) throw new Error('usage: node verify-required-blobs-r2.mjs <store-root> <fixed-source-root>');
const store = path.resolve(storeArg);
const source = path.resolve(sourceArg);
const require = createRequire(import.meta.url);
const {parse: parseYaml} = require(path.join(source, 'node_modules/yaml/dist/index.js'));
const lockPath = path.join(source, 'pnpm-lock.yaml');
const lock = parseYaml(fs.readFileSync(lockPath, 'utf8'));
const hash = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest('hex');
const packageFiles = [
  {name: '@earendil-works/pi-coding-agent', version: '1.4.0', relative: 'dist/index.js'},
  {name: '@earendil-works/pi-ai', version: '1.4.0', relative: 'dist/compat.js'},
  {name: 'better-sqlite3', version: '13.0.3', relative: 'prebuilds/win32-x64.node'},
];
const indexes = [];
for (const dir of fs.readdirSync(path.join(store, 'index'), {withFileTypes: true})) {
  if (!dir.isDirectory()) continue;
  for (const file of fs.readdirSync(path.join(store, 'index', dir.name))) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(store, 'index', dir.name, file);
    const entry = JSON.parse(fs.readFileSync(full, 'utf8'));
    if (packageFiles.some(pkg => entry.name === pkg.name && entry.version === pkg.version)) indexes.push({full, entry});
  }
}
const result = [];
for (const pkg of packageFiles) {
  const matches = indexes.filter(item => item.entry.name === pkg.name && item.entry.version === pkg.version);
  if (matches.length !== 1) throw new Error(`expected one cache index for ${pkg.name}@${pkg.version}, got ${matches.length}`);
  const {full: indexPath, entry} = matches[0];
  const lockKey = `${pkg.name}@${pkg.version}`;
  const lockEntry = lock.packages?.[lockKey];
  const packageIntegrity = lockEntry?.resolution?.integrity;
  if (!/^sha512-[A-Za-z0-9+/=]+$/.test(packageIntegrity ?? '')) throw new Error(`missing exact lockfile integrity for ${lockKey}`);
  const metadata = entry.files[pkg.relative];
  if (!metadata) throw new Error(`required runtime file missing from cache index: ${pkg.name}/${pkg.relative}`);
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(metadata.integrity ?? '');
  if (!match) throw new Error(`missing SHA-512 integrity for ${pkg.name}/${pkg.relative}`);
  const digest = Buffer.from(match[1], 'base64');
  const expectedHex = digest.toString('hex');
  const suffix = (metadata.mode & 0o111) !== 0 ? '-exec' : '';
  const blob = path.join(store, 'files', expectedHex.slice(0, 2), `${expectedHex.slice(2)}${suffix}`);
  const installed = path.join(source, 'node_modules', ...pkg.name.split('/'), ...pkg.relative.split('/'));
  const blobBytes = fs.readFileSync(blob);
  const installedBytes = fs.readFileSync(installed);
  const blobSha512 = hash('sha512', blobBytes);
  const installedSha512 = hash('sha512', installedBytes);
  if (blobSha512 !== expectedHex || installedSha512 !== expectedHex || blobBytes.length !== installedBytes.length || metadata.size !== undefined && installedBytes.length !== metadata.size) {
    throw new Error(`SRI mismatch for ${pkg.name}/${pkg.relative}`);
  }
  result.push({package: `${pkg.name}@${pkg.version}`, lockKey, packageIntegrity, indexPath, file: pkg.relative, blob, fileIntegrity: metadata.integrity, size: installedBytes.length, installedSha512, installedAndBlobMatchIndexSRI: true, lockfileEntryPresent: true});
}
process.stdout.write(`${JSON.stringify({store, source, lockPath, lockSha256: hash('sha256', fs.readFileSync(lockPath)), verified: result.length, files: result}, null, 2)}\n`);
