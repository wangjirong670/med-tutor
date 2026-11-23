import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const normalized = value => Buffer.from(value.toString('utf8').replace(/\r\n/g, '\n'));
const inside = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
const safe = (root, rel) => {
  if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error('invalid method path');
  const candidate = path.resolve(root, rel);
  if (!inside(root, candidate)) throw new Error('invalid method path');
  return candidate;
};

export function resolveMappedMethod(mappingPath, repoOverride) {
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
  const anchorPath = path.resolve(mapping.anchorPath);
  const anchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8'));
  const expectedOld = path.resolve(mapping.anchoredRepo);
  const actualOld = path.resolve(anchor.repo);
  if (actualOld.toLowerCase() !== expectedOld.toLowerCase()) throw new Error('method anchor old-path identity mismatch');
  const mappedRepo = path.resolve(repoOverride ?? mapping.mappedRepo);
  const expectedMapped = path.resolve(mapping.mappedRepo);
  if (mappedRepo.toLowerCase() !== expectedMapped.toLowerCase()) throw new Error('method mapping target mismatch');
  const actualReal = fs.realpathSync.native(mappedRepo);
  if (actualReal.toLowerCase() !== expectedMapped.toLowerCase()) throw new Error('method mapping realpath mismatch');

  const identities = [];
  for (const entry of anchor.files) {
    if (entry.exists !== true) continue;
    const file = safe(mappedRepo, entry.path);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`METHOD_SOURCE_DRIFT:missing:${entry.path}`);
    const actual = sha256(fs.readFileSync(file));
    if (actual !== entry.sha256) throw new Error(`METHOD_SOURCE_DRIFT:hash:${entry.path}`);
    identities.push({path: entry.path, sha256: actual});
  }

  const skillRoot = safe(mappedRepo, mapping.skillPath);
  const manifestPath = safe(skillRoot, 'references/snapshot/MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.sources) || manifest.sources.length !== 2) throw new Error('invalid method manifest');
  const parts = [];
  for (const entry of manifest.sources) {
    if (!['quickstart', 'method'].includes(entry.id) || !/^[a-f0-9]{64}$/.test(entry.source_sha256)) throw new Error('invalid method manifest source entry');
    const source = normalized(fs.readFileSync(safe(mappedRepo, entry.source_relpath)));
    const snapshotBytes = normalized(fs.readFileSync(safe(skillRoot, entry.snapshot_relpath)));
    const split = snapshotBytes.indexOf(Buffer.from('\n\n'));
    if (split < 0) throw new Error(`invalid method snapshot: ${entry.id}`);
    const snapshot = snapshotBytes.subarray(split + 2);
    if (sha256(source) !== entry.source_sha256 || sha256(snapshot) !== entry.source_sha256) throw new Error(`METHOD_SOURCE_DRIFT:manifest:${entry.id}`);
    parts.push({id: entry.id, sha256: entry.source_sha256, text: source.toString('utf8')});
  }
  const skillText = fs.readFileSync(safe(skillRoot, 'SKILL.md'), 'utf8');
  const longText = fs.readFileSync(safe(mappedRepo, 'docs/long-material.zh.md'), 'utf8');
  return {
    mode: 'source',
    mapping: {anchoredRepo: actualOld, mappedRepo: actualReal, anchorPath, skillPath: mapping.skillPath},
    anchorFiles: identities,
    sources: parts.map(({id, sha256: digest}) => ({id, sha256: digest})),
    text: [skillText, ...parts.map(x => x.text), longText].join('\n\n'),
  };
}
