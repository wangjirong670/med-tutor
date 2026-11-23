import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const require=createRequire(path.join(root,'package.json'));
const yaml=require('yaml');
const src=process.env.S07_CACHE_SOURCE?path.resolve(process.env.S07_CACHE_SOURCE):path.join(root,'.study/pi-migration/S02/execution-background-r2-build/src/pi-gui');
const cache=process.env.S07_CACHE_ROOT?path.resolve(process.env.S07_CACHE_ROOT):path.join(root,'.study/pi-migration/S01/execution/cache/pnpm/v10');
const lockPath=path.join(src,'pnpm-lock.yaml');
const lockBytes=fs.readFileSync(lockPath),lock=yaml.parse(lockBytes.toString('utf8'));
const dirs=[];for(const d of fs.readdirSync(path.join(cache,'index'),{withFileTypes:true}))if(d.isDirectory())dirs.push(d.name);
const indexes=[],parseErrors=[];
for(const d of dirs)for(const f of fs.readdirSync(path.join(cache,'index',d))){if(!f.endsWith('.json'))continue;const p=path.join(cache,'index',d,f);try{const x=JSON.parse(fs.readFileSync(p,'utf8'));if(!x.name||!x.version)throw Error('missing package identity');indexes.push({path:p,data:x,key:`${x.name}@${x.version}`})}catch(e){parseErrors.push({path:p,error:String(e)})}}
const byKey=new Map();for(const x of indexes){const a=byKey.get(x.key)??[];a.push(x);byKey.set(x.key,a)}
const lockKeys=Object.keys(lock.packages??{});
const lockCoverage=lockKeys.map(key=>({key,candidates:(byKey.get(key)??[]).map(x=>x.path),status:!byKey.has(key)?'missing':byKey.get(key).length>1?'duplicate':'indexed'}));
const integrity=(pkg)=>{const verified=[],missing=[],mismatched=[],errors=[];for(const [name,meta] of Object.entries(pkg.data.files??{})){try{const sri=meta.integrity??'',dash=sri.indexOf('-');if(dash<1)throw Error('invalid SRI');const alg=sri.slice(0,dash),expected=Buffer.from(sri.slice(dash+1),'base64').toString('hex');if(!['sha1','sha256','sha384','sha512'].includes(alg)||!expected)throw Error('unsupported SRI');const rel=path.join(cache,'files',expected.slice(0,2),expected.slice(2));const candidates=[rel,...((meta.mode&0o111)?[rel+'-exec']:[])];const found=candidates.find(fs.existsSync);if(!found){missing.push({path:name,integrity:sri,blobCandidates:candidates});continue}const actual=crypto.createHash(alg).update(fs.readFileSync(found)).digest('hex');if(actual===expected)verified.push({path:name,integrity:sri,blob:found});else mismatched.push({path:name,integrity:sri,blob:found,actual});}catch(e){errors.push({path:name,error:String(e)})}}return {verified,missing,mismatched,errors};};
const sqlite=lockKeys.find(k=>/^better-sqlite3@/.test(k));
const keys=['@earendil-works/pi-ai@1.4.0','@earendil-works/pi-coding-agent@1.4.0',sqlite,'pnpm@10.25.0'];
const critical=keys.map(key=>{const matches=byKey.get(key)??[];return {key,candidateCount:matches.length,duplicate:matches.length>1,files:matches.length===1?integrity(matches[0]):null}});
const result={schema:1,lock:{path:lockPath,sha256:crypto.createHash('sha256').update(lockBytes).digest('hex'),packageCount:lockKeys.length},cache:{root:cache,indexCount:indexes.length,parseErrors,lockCoverage:{indexed:lockCoverage.filter(x=>x.status==='indexed').length,missing:lockCoverage.filter(x=>x.status==='missing'),duplicates:lockCoverage.filter(x=>x.status==='duplicate')}},critical,provenance:{tarballToIndex:'unverified',dependencyClosure:'unverified',nativeAbi:'unverified',actualRestore:'unverified'}};
const out=process.argv[2];if(out){const dest=path.resolve(out),tmp=dest+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(result,null,2));fs.renameSync(tmp,dest)}else process.stdout.write(JSON.stringify(result,null,2));
