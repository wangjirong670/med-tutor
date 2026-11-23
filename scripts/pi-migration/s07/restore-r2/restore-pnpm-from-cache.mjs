import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [indexPathArg, cacheRootArg, destinationArg] = process.argv.slice(2);
if (!indexPathArg || !cacheRootArg || !destinationArg) {
  throw new Error('usage: node restore-pnpm-from-cache.mjs <index.json> <cache-root> <new-package-dir>');
}

const indexPath = path.resolve(indexPathArg);
const cacheRoot = path.resolve(cacheRootArg);
const destination = path.resolve(destinationArg);
const indexBytes = fs.readFileSync(indexPath);
const index = JSON.parse(indexBytes.toString('utf8'));
if (index.name !== 'pnpm' || index.version !== '10.25.0' || !index.files || typeof index.files !== 'object') {
  throw new Error('index is not the pinned pnpm@10.25.0 package');
}
if (fs.existsSync(destination)) throw new Error(`refusing to overwrite package directory: ${destination}`);
fs.mkdirSync(path.dirname(destination), {recursive: true});
fs.mkdirSync(destination, {recursive: false});

const destinationPrefix = `${destination}${path.sep}`;
let totalBytes = 0;
let copiedFiles = 0;
for (const [relativePath, metadata] of Object.entries(index.files)) {
  const segments = relativePath.split(/[\\/]/);
  if (!relativePath || path.isAbsolute(relativePath) || segments.some(segment => segment === '..' || segment === '.')) {
    throw new Error(`unsafe package path in cache index: ${relativePath}`);
  }
  const target = path.resolve(destination, ...segments);
  if (!target.startsWith(destinationPrefix)) throw new Error(`package path escaped destination: ${relativePath}`);

  const sri = metadata.integrity ?? '';
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(sri);
  if (!match) throw new Error(`unsupported or missing SHA-512 integrity: ${relativePath}`);
  const digest = Buffer.from(match[1], 'base64');
  if (digest.length !== 64) throw new Error(`invalid SHA-512 digest: ${relativePath}`);
  const hex = digest.toString('hex');
  const suffix = (metadata.mode & 0o111) !== 0 ? '-exec' : '';
  const blob = path.join(cacheRoot, 'files', hex.slice(0, 2), `${hex.slice(2)}${suffix}`);
  const stat = fs.lstatSync(blob);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`invalid cache blob: ${relativePath}`);
  if (metadata.size !== undefined && stat.size !== metadata.size) throw new Error(`cache blob size mismatch: ${relativePath}`);
  const bytes = fs.readFileSync(blob);
  if (!crypto.timingSafeEqual(crypto.createHash('sha512').update(bytes).digest(), digest)) {
    throw new Error(`cache blob SRI mismatch: ${relativePath}`);
  }

  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.copyFileSync(blob, target, fs.constants.COPYFILE_EXCL);
  totalBytes += bytes.length;
  copiedFiles += 1;
}

const packageJsonPath = path.join(destination, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
if (packageJson.name !== 'pnpm' || packageJson.version !== '10.25.0') throw new Error('restored package metadata mismatch');
const summary = {
  package: `${packageJson.name}@${packageJson.version}`,
  indexPath,
  indexSha256: crypto.createHash('sha256').update(indexBytes).digest('hex'),
  destination,
  copiedFiles,
  totalBytes,
  packageJsonSha256: crypto.createHash('sha256').update(fs.readFileSync(packageJsonPath)).digest('hex'),
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
