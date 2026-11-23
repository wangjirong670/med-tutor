import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../../../..');
const allowed = path.resolve(projectRoot, '.study/pi-migration/S07/execution-s07a/restore-r2/prepare-fixture');
const target = path.resolve(process.argv[2] ?? '');
const rel = path.relative(allowed, target);
if (!target || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('prepare target outside R2 fixture root');
fs.mkdirSync(allowed, {recursive: true});
if (fs.existsSync(target)) throw new Error('S07A_R2_PREPARE_TARGET_EXISTS');
fs.mkdirSync(target, {recursive: false});
const record = {target, createdAt: new Date().toISOString(), rebuildable: true, existingTargetPolicy: 'refuse'};
fs.writeFileSync(path.join(target, 'prepare.json'), JSON.stringify(record, null, 2), {flag: 'wx'});
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
