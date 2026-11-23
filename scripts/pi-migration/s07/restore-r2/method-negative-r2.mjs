import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveMappedMethod} from './method-resolver-r2.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../../../..');
const mappingPath = path.join(scriptDir, 'method-map-r2.json');
const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
const anchor = JSON.parse(fs.readFileSync(mapping.anchorPath, 'utf8'));
const fixture = path.resolve(projectRoot, '.study/pi-migration/S07/execution-s07a/restore-r2/method-drift-fixture');
if (fs.existsSync(fixture)) throw new Error('method drift fixture already exists; refusing overwrite');
fs.mkdirSync(fixture, {recursive: true});
for (const entry of anchor.files) {
  if (entry.exists !== true) continue;
  const source = path.resolve(mapping.mappedRepo, entry.path);
  const target = path.resolve(fixture, entry.path);
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}
const changed = path.join(fixture, 'docs/long-material.zh.md');
fs.appendFileSync(changed, '\nR2_SYNTHETIC_DRIFT_SENTINEL\n');
const fixtureMap = path.join(fixture, 'method-map-fixture.json');
fs.writeFileSync(fixtureMap, JSON.stringify({...mapping, mappedRepo: fixture}, null, 2), {flag: 'wx'});
let rejected = false;
let message = '';
try {
  resolveMappedMethod(fixtureMap);
} catch (error) {
  message = String(error.message ?? error);
  rejected = message.startsWith('METHOD_SOURCE_DRIFT:');
}
const result = {fixture, mutatedFile: changed, rejected, message};
fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2), {flag: 'wx'});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!rejected) process.exitCode = 1;
