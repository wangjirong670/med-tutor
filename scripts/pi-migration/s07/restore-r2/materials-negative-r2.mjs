import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Materials} from './materials.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../../../..');
const mapping = JSON.parse(fs.readFileSync(path.join(scriptDir, 'method-map-r2.json'), 'utf8'));
const fixture = path.resolve(projectRoot, '.study/pi-migration/S07/execution-s07a/restore-r2/material-junction-fixture');
if (fs.existsSync(fixture)) throw new Error('material junction fixture already exists; refusing overwrite');
const staging = path.join(fixture, 'staging');
fs.mkdirSync(staging, {recursive: true});
const link = path.join(staging, 'escaped-source');
const outsideFile = path.join(mapping.mappedRepo, 'docs/long-material.zh.md');
fs.symlinkSync(path.dirname(outsideFile), link, 'junction');
let rejected = false;
let message = '';
try {
  new Materials(path.join(fixture, 'materials')).stageFile(staging, path.join(link, path.basename(outsideFile)), 'r2-junction-negative');
} catch (error) {
  message = String(error.message ?? error);
  rejected = message === 'unapproved path';
}
try { fs.unlinkSync(link); } catch {}
const result = {fixture, staging, junction: link, target: outsideFile, rejected, message, externalTargetModified: false};
fs.writeFileSync(path.join(fixture, 'result.json'), JSON.stringify(result, null, 2), {flag: 'wx'});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!rejected) process.exitCode = 1;
