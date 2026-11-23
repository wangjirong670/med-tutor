const fs=require('node:fs'),path=require('node:path');
const root=process.cwd(), modules=path.join(root,'src/pi-gui/node_modules');
const result={runtime:process.versions,modules:{}};
for(const name of ['node-pty','@silvia-odwyer/photon-node']){
 try{const m=require(path.join(modules,name));result.modules[name]={loaded:true,exports:Object.keys(m).slice(0,5)};}catch(e){result.modules[name]={loaded:false,error:String(e)};}
}
try{const m=require(path.join(modules,'node-pty/lib/utils.js')).loadNativeModule('conpty');result.conpty={loaded:true,exports:Object.keys(m.module)};}catch(e){result.conpty={loaded:false,error:String(e)};}
result.passed=Object.values(result.modules).every(m=>m.loaded)&&result.conpty.loaded;
fs.writeFileSync(path.join(root,`logs/native-${process.versions.electron?'electron':'host'}.json`),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));process.exitCode=result.passed?0:1;
