import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const candidate = path.dirname(fileURLToPath(import.meta.url));
assert.equal(fs.realpathSync.native(candidate).toLowerCase(), candidate.toLowerCase());
const prior = path.resolve(candidate, '../r2');
const study = path.resolve(candidate, '../..');
const project = path.resolve(study, '../../..');
const mainPath = 'runtime/src/pi-gui/apps/desktop/out/main/main.js';
const sealedMain = 'c8103d119f7eee1d0dc8084078d1709300448a158397870170ca3473fe9c4014';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function check(file, receipt) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.length, receipt.bytes, file);
  assert.equal(sha256(bytes), receipt.sha256, file);
  return bytes;
}

const r4 = JSON.parse(fs.readFileSync(path.join(study, 'execution-s08b/r4/S08B_FILES_R4.json')));
assert.equal(r4.files.length, 53);
for (const entry of r4.files) check(path.join(project, entry.path), entry);
const sealedReceipt = fs.readFileSync(path.join(prior, 'evidence/runtime-build-map.json'));
assert.equal(sha256(sealedReceipt), '0127bd4d04dc9a098db79afda64005dfdec97b9cba5fc21c964fbb4980e94d05');
const r2 = JSON.parse(sealedReceipt);
assert.equal(r2.files.length, 13);
const baseline = fs.readFileSync(path.join(candidate, 'main-builds/baseline-rtwo/main-with-r4.js'));
assert.equal(sha256(baseline), sealedMain, 'reconstructed R2');
const build = path.join(candidate, 'main-builds/release-final');
const main = fs.readFileSync(path.join(build, 'main-with-r4.js'));
const derivation = JSON.parse(fs.readFileSync(path.join(build, 'derivation.json')));
assert.equal(sha256(main), derivation.withWorkbench);
assert.notEqual(sha256(main), sealedMain);

const files = r2.files.map(file => {
  const previous = check(path.join(prior, file.relative), file);
  const bytes = file.relative === mainPath ? main : previous;
  return { relative: file.relative, bytes, r2Sha256: file.sha256, sha256: sha256(bytes) };
});
assert.deepEqual(files.filter(file => file.sha256 !== file.r2Sha256).map(file => file.relative), [mainPath]);
const runtime = path.join(candidate, 'runtime');
fs.mkdirSync(runtime);
for (const file of files) {
  const destination = path.join(candidate, file.relative);
  assert(destination.startsWith(runtime + path.sep));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, file.bytes, { flag: 'wx' });
  assert(fs.readFileSync(destination).equals(file.bytes));
}
const receipt = {
  checkedR4OwnedFiles: r4.files.length,
  checkedR2StaticAssets: r2.files.length,
  sameR2StaticAssets: files.length - 1,
  rendererModule: r2.rendererModule,
  files: files.map(({ bytes, ...file }) => ({ ...file, bytes: bytes.length })),
};
fs.writeFileSync(path.join(candidate, 'evidence/runtime-build-map.json'),
  JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log({ mainSha256: sha256(main), unchanged: receipt.sameR2StaticAssets });
