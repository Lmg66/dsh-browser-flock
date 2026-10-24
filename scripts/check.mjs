import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const root=process.cwd();
async function walk(directory) {
  const files=[];
  for(const entry of await readdir(directory,{withFileTypes:true})) {
    if(['node_modules','.git'].includes(entry.name)) continue;
    const target=path.join(directory,entry.name);
    if(entry.isDirectory()) files.push(...await walk(target));
    else if(/\.(?:js|mjs)$/.test(entry.name)) files.push(target);
  }
  return files;
}
JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
for(const file of await walk(root)) {
  const result=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});
  if(result.status!==0) process.exit(result.status??1);
}
console.log('Manifest JSON and JavaScript syntax checks passed.');
