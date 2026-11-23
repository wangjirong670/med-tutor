import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../../../..');
const evidenceRoot = path.join(projectRoot, '.study/pi-migration/S07/execution-s07a/restore-r2');
const reportPath = path.join(projectRoot, 'docs/pi-migration/S07A_RESTORE_EXECUTION_R2.md');
const manifestPath = path.join(evidenceRoot, 'S07A_RESTORE_FILES_R2.json');
const sourceRoot = path.join(scriptDir);
const roots = [sourceRoot, evidenceRoot];
const omit = new Set([manifestPath.toLowerCase()]);
const files = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (omit.has(full.toLowerCase())) continue;
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) {
      const linkTarget = fs.readlinkSync(full);
      const realpath = fs.realpathSync.native(full);
      if (!roots.some(root => {
        const rel = path.relative(root, realpath);
        return rel === '' || rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
      })) throw new Error(`reparse target outside R2 roots: ${full} -> ${realpath}`);
      const bytes = Buffer.byteLength(linkTarget);
      files.push({path: path.relative(projectRoot, full).replaceAll(path.sep, '/'), type: 'symlink', bytes, sha256: crypto.createHash('sha256').update(linkTarget).digest('hex'), linkTarget, realpath});
      continue;
    }
    if (stat.isDirectory()) walk(full);
    else if (stat.isFile()) files.push({path: path.relative(projectRoot, full).replaceAll(path.sep, '/'), type: 'file', bytes: stat.size, fullPath: full});
    else throw new Error(`unsupported filesystem entry: ${full}`);
  }
}

walk(sourceRoot);
walk(evidenceRoot);
const reportStat = fs.statSync(reportPath);
files.push({path: path.relative(projectRoot, reportPath).replaceAll(path.sep, '/'), type: 'file', bytes: reportStat.size, fullPath: reportPath});
files.sort((a, b) => a.path.localeCompare(b.path));

let next = 0;
async function hashWorker() {
  while (true) {
    const index = next++;
    if (index >= files.length) return;
    const item = files[index];
    if (item.type !== 'file') continue;
    const digest = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(item.fullPath, {highWaterMark: 1024 * 1024});
      stream.on('data', chunk => digest.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    item.sha256 = digest.digest('hex');
    delete item.fullPath;
  }
}
await Promise.all(Array.from({length: 8}, () => hashWorker()));

const totalBytes = files.reduce((sum, item) => sum + item.bytes, 0);
const manifest = {
  schema: 1,
  task: 'S07A:restore:R2:20261103',
  frozenAtLocal: new Date().toISOString(),
  projectRoot,
  roots: [path.relative(projectRoot, sourceRoot).replaceAll(path.sep, '/'), path.relative(projectRoot, evidenceRoot).replaceAll(path.sep, '/'), path.relative(projectRoot, reportPath).replaceAll(path.sep, '/')],
  count: files.length,
  totalBytes,
  hashAlgorithm: 'SHA-256',
  symlinkHashDefinition: 'SHA-256 of link target text; realpath recorded and constrained to R2 roots.',
  manifestSelfExcluded: true,
  files,
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), {flag: 'w'});
process.stdout.write(`${JSON.stringify({manifestPath, count: manifest.count, totalBytes, regularFiles: files.filter(file => file.type === 'file').length, symlinks: files.filter(file => file.type === 'symlink').length, reportPath, selfExcluded: true}, null, 2)}\n`);
