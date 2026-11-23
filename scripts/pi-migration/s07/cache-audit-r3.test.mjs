import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const auditScript = path.join(repo, 'scripts/pi-migration/s07/cache-audit-r2.mjs');
const evidenceRoot = path.join(repo, '.study/pi-migration/S07/execution-s07a/cache-r3');
const primaryFixtureRoot = path.join(evidenceRoot, 'fixture');
const fixtureRoot = process.env.S07_CACHE_R3_FIXTURE_ROOT
  ? path.resolve(process.env.S07_CACHE_R3_FIXTURE_ROOT)
  : fs.existsSync(primaryFixtureRoot)
    ? fs.mkdtempSync(path.join(os.tmpdir(), 's07-cache-r3-replay-'))
    : primaryFixtureRoot;

test('synthetic counterexamples execute frozen R2 cache audit and assert F03 cases', () => {
  assert.equal(fs.existsSync(fixtureRoot), false, `refusing to overwrite existing evidence: ${fixtureRoot}`);
  fs.mkdirSync(fixtureRoot, {recursive: false});

  const sourceRoot = path.join(fixtureRoot, 'source');
  const cacheRoot = path.join(fixtureRoot, 'cache');
  const indexRoot = path.join(cacheRoot, 'index', 'aa');
  const filesRoot = path.join(cacheRoot, 'files');
  const auditOutput = path.join(fixtureRoot, 'audit-output.json');
  fs.mkdirSync(sourceRoot, {recursive: true});
  fs.mkdirSync(indexRoot, {recursive: true});
  fs.mkdirSync(filesRoot, {recursive: true});

  const putIndex = (name, version, files) => {
    const filename = `${crypto.createHash('sha1').update(`${name}@${version}`).digest('hex')}-${name.replaceAll('/', '+')}@${version}.json`;
    fs.writeFileSync(path.join(indexRoot, filename), JSON.stringify({name, version, files}, null, 2));
  };

  const addBlob = (fileContent, mode = 0o644) => {
    const bytes = Buffer.from(fileContent);
    const digest = crypto.createHash('sha512').update(bytes).digest('base64');
    const hexDigest = Buffer.from(digest, 'base64').toString('hex');
    const blobPath = path.join(filesRoot, hexDigest.slice(0, 2), `${hexDigest.slice(2)}${mode & 0o111 ? '-exec' : ''}`);
    fs.mkdirSync(path.dirname(blobPath), {recursive: true});
    fs.writeFileSync(blobPath, bytes);
    return {integrity: `sha512-${digest}`, mode, size: bytes.length, blobPath};
  };

  // The quoted scoped key exercises YAML parsing of a real scoped lock entry.
  const scopedFile = addBlob('scoped package entry');
  putIndex('@scope/pkg', '1.0.0', {'index.js': scopedFile});

  // This package index is deliberately outside the lock and its sole blob is -exec.
  const executable = addBlob('synthetic pnpm executable payload', 0o755);
  putIndex('pnpm', '10.25.0', {'bin/pnpm.cjs': executable});

  const piFile = addBlob('synthetic Pi package entry');
  putIndex('@earendil-works/pi-ai', '1.4.0', {'index.js': piFile});
  putIndex('@earendil-works/pi-coding-agent', '1.4.0', {'index.js': piFile});
  const sqliteFile = addBlob('synthetic native package entry');
  putIndex('better-sqlite3', '13.0.3', {'binding.node': sqliteFile});

  const lockText = [
    "lockfileVersion: '9.0'",
    'packages:',
    "  '@scope/pkg@1.0.0': {}",
    '  missing-pkg@2.0.0: {}',
    "  '@earendil-works/pi-ai@1.4.0': {}",
    "  '@earendil-works/pi-coding-agent@1.4.0': {}",
    '  better-sqlite3@13.0.3: {}',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(sourceRoot, 'pnpm-lock.yaml'), lockText);
  assert.equal(lockText.includes('pnpm@10.25.0'), false, 'pnpm must remain absent from the synthetic lock');

  // Invoke the frozen implementation with only its supported source/cache path overrides.
  const run = spawnSync(process.execPath, [auditScript, auditOutput], {
    encoding: 'utf8',
    env: {...process.env, S07_CACHE_SOURCE: sourceRoot, S07_CACHE_ROOT: cacheRoot},
  });
  fs.writeFileSync(path.join(fixtureRoot, 'audit-stdout.log'), run.stdout ?? '');
  fs.writeFileSync(path.join(fixtureRoot, 'audit-stderr.log'), run.stderr ?? '');
  fs.writeFileSync(path.join(fixtureRoot, 'audit-process.json'), JSON.stringify({
    command: [process.execPath, auditScript, auditOutput],
    status: run.status,
    signal: run.signal,
    error: run.error ? String(run.error) : null,
  }, null, 2));
  assert.equal(run.error, undefined, `audit process error: ${run.error}`);
  assert.equal(run.status, 0, `audit exit ${run.status}; stderr: ${run.stderr}`);

  const out = JSON.parse(fs.readFileSync(auditOutput, 'utf8'));
  const missing = out.cache.lockCoverage.missing;
  assert.equal(missing.length, 1, 'exactly one locked package must lack an index');
  assert.equal(missing[0].key, 'missing-pkg@2.0.0', 'missing package identity must be reported exactly');
  assert.equal(out.cache.lockCoverage.indexed, 4, 'the four indexed lock entries must be counted');

  const pnpm = out.critical.find(item => item.key === 'pnpm@10.25.0');
  assert.ok(pnpm, 'pnpm must be looked up independently of lock membership');
  assert.equal(pnpm.candidateCount, 1, 'the lock-external pnpm index must be found');
  assert.equal(pnpm.files.missing.length, 0, 'the synthetic pnpm file must resolve');
  const verifiedExec = pnpm.files.verified.find(file => file.path === 'bin/pnpm.cjs');
  assert.ok(verifiedExec, 'the pnpm executable file must be verified');
  assert.ok(verifiedExec.blob.endsWith('-exec'), `expected the -exec blob path, got ${verifiedExec.blob}`);
  assert.equal(fs.existsSync(verifiedExec.blob.slice(0, -'-exec'.length)), false, 'no ordinary blob may mask -exec lookup');
  const actualBytes = fs.readFileSync(verifiedExec.blob);
  assert.equal(actualBytes.toString(), 'synthetic pnpm executable payload', 'the actual -exec blob content must match');
  assert.equal(`sha512-${crypto.createHash('sha512').update(actualBytes).digest('base64')}`, executable.integrity,
    'the actual -exec blob SRI must match the synthetic index');

  assert.equal(out.provenance.tarballToIndex, 'unverified');
  assert.equal(out.provenance.dependencyClosure, 'unverified');
  assert.equal(out.provenance.nativeAbi, 'unverified');
  assert.equal(out.provenance.actualRestore, 'unverified');
});
