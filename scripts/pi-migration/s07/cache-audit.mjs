import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const source = path.join(projectRoot, '.study/pi-migration/S02/execution-background-r2-build/src/pi-gui');
const lockFile = path.join(source, 'pnpm-lock.yaml');
const cache = path.join(projectRoot, '.study/pi-migration/S01/execution/cache/pnpm/v10');
const hash = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest('hex');
const lockHash = hash('sha256', fs.readFileSync(lockFile));
const lock = fs.readFileSync(lockFile, 'utf8');
const indexFiles = [];
for (const dir of fs.readdirSync(path.join(cache, 'index'), {withFileTypes: true})) {
  if (!dir.isDirectory()) continue;
  const prefix = path.join(cache, 'index', dir.name);
  const walk = current => {
    for (const ent of fs.readdirSync(current, {withFileTypes: true})) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.json')) indexFiles.push(full);
    }
  };
  walk(prefix);
}
const lockPackages = new Map();
for (const line of lock.split(/\r?\n/)) {
  const m = line.match(/^  ['"]?((?:@[^/]+\/)?[^@'" ][^:'"]*)@([^:'"( ]+)(?:\([^)]*\))?:$/);
  if (m) lockPackages.set(`${m[1]}@${m[2]}`, {name: m[1], version: m[2]});
}
const entries = [];
for (const file of indexFiles) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
  const name = data.name ?? data.package?.name;
  const version = data.version ?? data.package?.version;
  if (!name || !version || !lockPackages.has(`${name}@${version}`)) continue;
  const files = [];
  for (const [relative, spec] of Object.entries(data.files ?? {})) {
    const sri = spec.integrity ?? '';
    const [algorithm, encoded] = sri.split('-', 2);
    const digest = encoded ? Buffer.from(encoded, 'base64').toString('hex') : '';
    const blob = digest ? path.join(cache, 'files', digest.slice(0, 2), digest.slice(2)) : '';
    const exists = !!blob && fs.existsSync(blob);
    const matches = exists && hash(algorithm, fs.readFileSync(blob)) === digest;
    files.push({path: relative, integrity: sri, blobExists: exists, integrityMatches: !!matches});
  }
  const native = files.filter(f => /(?:sqlite|\.node$|prebuild|binding\.gyp|node-gyp)/i.test(f.path));
  entries.push({name, version, lockReference: `${name}@${version}`, integrity: data.resolution?.integrity ?? null,
    fileCount: files.length, cachedVerifiedFiles: files.filter(f => f.integrityMatches).length,
    missingOrMismatchedFiles: files.filter(f => !f.integrityMatches), nativeBuildFiles: native});
}
const requiredName = /^(?:@earendil-works\/(?:pi-ai|pi-coding-agent)|@pi-gui\/(?:pi-sdk-driver|session-driver|catalogs)|pi-hermes-memory|better-sqlite3|sqlite3)$/;
const selected = entries.filter(x => requiredName.test(x.name) || /sqlite/i.test(x.name));
const result = {
  projectRoot, source, lockFile, lockSha256: lockHash, packageManager: JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).packageManager,
  cacheRoot: cache, indexJsonCount: indexFiles.length,
  auditScope: 'S01 content-addressed cache index entries matching exact package name/version references from fixed S02 pnpm lock; selected direct Pi runtime, SDK, memory and SQLite packages',
  selectedPackages: selected,
  pinnedPnpmExecutableCached: entries.filter(x => x.name === 'pnpm' && x.version === '10.25.0'),
  note: 'Only cache index entries present in this S01 snapshot can be audited. Lock references without matching index entries are reported as unavailable and are not inferred from a different version.'
};
console.log(JSON.stringify(result, null, 2));
