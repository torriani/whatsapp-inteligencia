import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
let count=0;
for(const dir of ['worker/src','worker/test','gateway/dist','gateway/test','scripts']) {
 if(!fs.existsSync(dir))continue;
 for(const name of fs.readdirSync(dir)) if(/\.(mjs|js)$/.test(name)) {
  const r=spawnSync(process.execPath,['--check',path.join(dir,name)],{stdio:'inherit'});
  if(r.status!==0)process.exit(r.status??1);count++;
 }
}
console.log(`${count} arquivos JavaScript: sintaxe OK`);
