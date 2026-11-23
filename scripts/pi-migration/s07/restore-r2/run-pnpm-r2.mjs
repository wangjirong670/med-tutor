import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../../../..');
const expectedStore = path.resolve(projectRoot, '.study/pi-migration/S07/execution-s07a/restore-r2/store/pnpm/v10');
const protectedStores = [
  path.resolve(projectRoot, '.study/pi-migration/S01/execution/cache/pnpm/v10'),
  path.resolve(projectRoot, '.study/pi-migration/S07/execution-s07a/restore-r1'),
  path.resolve(projectRoot, '.study/pi-migration/S07/execution-s07a/restore-r2/store/pnpm/v10-old'),
];
const cli = path.join(scriptDir, 'tooling/pnpm-10.25.0/bin/pnpm.cjs');

function normalized(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

function reject(message) {
  process.stderr.write(`R2_STORE_GUARD_REJECTED: ${message}\n`);
  process.exit(91);
}

const args = process.argv.slice(2);
let storeArg;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--store-dir') {
    if (storeArg !== undefined || !args[i + 1]) reject('missing or duplicate --store-dir');
    storeArg = args[i + 1];
    i += 1;
  } else if (args[i].startsWith('--store-dir=')) {
    if (storeArg !== undefined) reject('duplicate --store-dir');
    storeArg = args[i].slice('--store-dir='.length);
  }
}
if (!storeArg) reject('explicit --store-dir is required');
if (!path.isAbsolute(storeArg)) reject('--store-dir must be an absolute path');

const canonicalStore = path.resolve(storeArg);
let realStore;
try {
  realStore = fs.realpathSync.native(canonicalStore);
} catch (error) {
  reject(`cannot resolve --store-dir: ${error.message}`);
}
if (normalized(canonicalStore) !== normalized(expectedStore)) reject('canonical --store-dir is not the R2 store');
if (normalized(realStore) !== normalized(expectedStore)) reject('realpath --store-dir is not the R2 store');
if (protectedStores.some(p => normalized(p) === normalized(realStore))) reject('store resolves to a protected path');
if (!fs.statSync(realStore).isDirectory()) reject('--store-dir is not a directory');
if (!fs.existsSync(cli)) reject(`pinned pnpm CLI is missing: ${cli}`);

process.stdout.write(`${JSON.stringify({guard: 'passed', canonicalStore, realStore, cli, command: args[0] ?? null})}\n`);
const pnpmArgs = args[0] === 'install'
  ? args
  : args.filter((arg, index) => arg !== '--store-dir' && !(index > 0 && args[index - 1] === '--store-dir') && !arg.startsWith('--store-dir='));
const child = spawnSync(process.execPath, [cli, ...pnpmArgs], {
  cwd: process.cwd(),
  env: {...process.env, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_store_dir: canonicalStore},
  stdio: 'inherit',
});
if (child.error) {
  process.stderr.write(`${child.error.stack ?? child.error.message}\n`);
  process.exit(92);
}
process.exit(child.status ?? 93);
