"""Read installed package manifests and binary hashes, without importing packages."""
import hashlib,json,os,pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve(); dest=pathlib.Path(sys.argv[2])
modules=root/'src/pi-gui/node_modules'; packages=[]
for directory,dirs,files in os.walk(modules,followlinks=False):
 if 'package.json' not in files: continue
 p=pathlib.Path(directory)/'package.json'
 package_dir=p.parent
 if not (package_dir.parent.name=='node_modules' or (package_dir.parent.name.startswith('@') and package_dir.parent.parent.name=='node_modules')):continue
 try: data=json.loads(p.read_text(encoding='utf-8-sig'))
 except (ValueError,UnicodeError): continue
 if not isinstance(data.get('name'),str) or not isinstance(data.get('version'),str):continue
 scripts=data.get('scripts',{})
 licenses=[]
 for f in pathlib.Path(directory).iterdir():
  if f.is_file() and f.name.lower().split('.')[0] in ('license','licence','notice','copying'):
   licenses.append(dict(path=str(f.relative_to(root)).replace('\\','/'),sha256=hashlib.sha256(f.read_bytes()).hexdigest()))
 packages.append(dict(path=str(p.relative_to(root)).replace('\\','/'),name=data['name'],version=data['version'],license=data.get('license',data.get('licenses')),manifestSha256=hashlib.sha256(p.read_bytes()).hexdigest(),engines=data.get('engines'),lifecycle={k:scripts[k] for k in ('preinstall','install','postinstall','prepare') if k in scripts},licenseFiles=licenses))
binary=[]
for folder in [modules/'electron/dist',modules/'better-sqlite3/prebuilds',modules/'node-pty/prebuilds',modules/'@silvia-odwyer/photon-node',root/'home/electron/Cache']:
 if not folder.exists():continue
 for p in folder.rglob('*'):
  if p.is_file() and (p.suffix.lower() in ('.node','.zip','.wasm') or p.name=='electron.exe'):
   binary.append(dict(path=str(p.relative_to(root)).replace('\\','/'),bytes=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest()))
result=dict(packageManifestCount=len(packages),packages=sorted(packages,key=lambda p:p['path']),binaries=binary)
dest.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print('captured manifests:',len(packages),'binaries:',len(binary))
