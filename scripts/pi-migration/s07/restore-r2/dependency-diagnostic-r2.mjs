import fs from 'node:fs';
import path from 'node:path';

const rootArg = process.argv[2];
if (!rootArg) throw new Error('usage: node dependency-diagnostic-r2.mjs <fixed-source-root>');
const root = path.resolve(rootArg);
const required = [
  'node_modules/@earendil-works/pi-coding-agent/dist/index.js',
  'node_modules/@earendil-works/pi-ai/dist/compat.js',
  'packages/hermes-memory/dist/index.js',
  'node_modules/better-sqlite3/lib/index.js',
];
const missing = required.filter(rel => !fs.existsSync(path.join(root, rel)));
const result = {code: missing.length ? 'S07A_FIXED_DEPENDENCY_MISSING' : 'S07A_FIXED_DEPENDENCIES_PRESENT', root, required, missing};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (missing.length) process.exitCode = 12;
