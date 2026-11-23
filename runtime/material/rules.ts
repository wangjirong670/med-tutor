import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash } from './store.js';

export function loadRules(root = resolve(process.cwd(), '../med-ai-workflow')) {
  const skillDir = join(root, 'skills/med-study-knead');
  const manifest = JSON.parse(readFileSync(join(skillDir, 'references/snapshot/MANIFEST.json'), 'utf8')) as { sources: { source_relpath: string; source_sha256: string; snapshot_relpath: string }[] };
  const normalized = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const dev = manifest.sources.every(s => existsSync(join(root, s.source_relpath)) && hash(normalized(join(root, s.source_relpath))) === s.source_sha256);
  const parts = manifest.sources.map(s => {
    if (dev) return normalized(join(root, s.source_relpath));
    const snapshot = normalized(join(skillDir, s.snapshot_relpath));
    const body = snapshot.slice(snapshot.indexOf('\n\n') + 2);
    if (hash(body) !== s.source_sha256) throw Error('skill 快照正文与 manifest 哈希不符；停止规则加载');
    return body;
  });
  const skill = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
  const long = readFileSync(join(root, 'docs/long-material.zh.md'), 'utf8');
  let commit = 'unknown'; try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim(); } catch { /* content hashes remain authority */ }
  const text = [...parts, long].join('\n\n');
  return { mode: dev ? 'dev' : 'snapshot', note: dev ? '依据仓内实时 prompt（快照哈希一致）' : '依据 skill 快照（非仓内实时 prompt）', commit, hash: hash(text), skillHash: hash(skill), longHash: hash(long), text };
}
