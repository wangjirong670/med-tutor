import fs from 'node:fs';
import path from 'node:path';

const [sourceArg, storeArg] = process.argv.slice(2);
if (!sourceArg || !storeArg) throw new Error('usage: node verify-r2-links.mjs <fixed-source-root> <r2-store-root>');
const source = fs.realpathSync.native(path.resolve(sourceArg));
const store = fs.realpathSync.native(path.resolve(storeArg));
const links = [];
const inside = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
function walk(dir) {
  for (const item of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, item.name);
    if (item.isSymbolicLink()) {
      const target = fs.realpathSync.native(full);
      links.push({path: full, target, insideSource: inside(source, target)});
      continue;
    }
    if (item.isDirectory()) walk(full);
  }
}
walk(source);
const storeLinks = [];
function walkStore(dir) {
  for (const item of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, item.name);
    if (item.isSymbolicLink()) storeLinks.push(full);
    else if (item.isDirectory()) walkStore(full);
  }
}
walkStore(store);
const outside = links.filter(item => !item.insideSource);
const result = {source, store, sourceReparseCount: links.length, sourceLinks: links, outsideSourceTargets: outside, storeReparseCount: storeLinks.length, storeLinks, passed: outside.length === 0 && storeLinks.length === 0};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.passed) process.exitCode = 1;
