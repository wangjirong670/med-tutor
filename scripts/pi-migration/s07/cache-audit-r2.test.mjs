import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const result=JSON.parse(fs.readFileSync(path.join(root,'.study/pi-migration/S07/execution-s07a/cache-r2/cache-audit.json'),'utf8'));
test('structured lock parser includes quoted scoped package references and reports missing index keys',()=>{
 assert.ok(result.lock.packageCount>1000);
 assert.ok(result.cache.lockCoverage.indexed>0);
 assert.deepEqual(result.cache.lockCoverage.missing,[]);
 assert.ok(result.critical.some(x=>x.key==='@earendil-works/pi-ai@1.4.0'));
});
test('independent pnpm lookup verifies executable content-addressed blobs',()=>{
 const p=result.critical.find(x=>x.key==='pnpm@10.25.0');
 assert.ok(p,'pnpm must be discovered independently in all cache indexes');
 assert.ok(p.files.verified.some(x=>x.path==='bin/pnpm.cjs'));
 assert.equal(p.files.missing.length,0);
});
test('SRI verification finds executable-mode blobs using the -exec suffix',()=>{
 const p=result.critical.find(x=>x.key==='better-sqlite3@13.0.3');
 assert.ok(p);
 assert.ok(p.files.verified.length>0);
 assert.equal(p.files.missing.length,0);
 assert.equal(p.files.mismatched.length,0);
});
test('result does not claim unverified tarball provenance, closure, ABI, or restore',()=>{
 assert.equal(result.provenance.tarballToIndex,'unverified');
 assert.equal(result.provenance.dependencyClosure,'unverified');
 assert.equal(result.provenance.nativeAbi,'unverified');
 assert.equal(result.provenance.actualRestore,'unverified');
});
