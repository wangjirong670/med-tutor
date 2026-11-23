import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveMappedMethod, sha256} from './method-resolver-r2.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../../../..');
const mappingPath = path.join(scriptDir, 'method-map-r2.json');
const evidenceRoot = path.resolve(projectRoot, '.study/pi-migration/S07/execution-s07a/restore-r2');
const sandbox = path.join(evidenceRoot, 'sandbox');
const outPath = path.join(sandbox, 'method-context.json');
fs.mkdirSync(sandbox, {recursive: true});
const method = resolveMappedMethod(mappingPath);
const bytes = Buffer.from(JSON.stringify(method));
if (fs.existsSync(outPath)) {
  const existing = fs.readFileSync(outPath);
  if (!existing.equals(bytes)) throw new Error('refusing to overwrite different staged method context');
} else {
  fs.writeFileSync(outPath, bytes, {flag: 'wx'});
}
const record = {path: outPath, bytes: bytes.length, sha256: sha256(bytes), mode: method.mode, mapping: method.mapping, anchorFiles: method.anchorFiles, sources: method.sources};
fs.writeFileSync(path.join(evidenceRoot, 'method-stage-r2.json'), JSON.stringify(record, null, 2), {flag: 'wx'});
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
