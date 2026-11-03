import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir, lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// This guard inspects this repository only. It neither reads the user's home
// configuration nor prints matching content when a possible secret is found.
const root=fileURLToPath(new URL('../',import.meta.url));
const ignored=new Set(['.git','node_modules','coverage','playwright-report','test-results']);
async function files(dir=root){
  const result=[];
  for(const item of await readdir(dir,{withFileTypes:true})){
    if(ignored.has(item.name))continue;
    const name=path.join(dir,item.name);
    assert.ok(!item.isSymbolicLink(),`Release checkout contains a symlink: ${path.relative(root,name)}`);
    if(item.isDirectory())result.push(...await files(name));
    else if(item.isFile())result.push(name);
  }
  return result;
}
function isPlaceholderHome(value){
  const user=value.split('/')[2];
  return ['your-user','user','username','example','<user>','<username>'].includes(user);
}
function publicAddress(value){
  const bytes=value.split('.').map(Number);
  return bytes[0]===127||value==='0.0.0.0'
    ||bytes[0]===192&&bytes[1]===0&&bytes[2]===2
    ||bytes[0]===198&&bytes[1]===51&&bytes[2]===100
    ||bytes[0]===203&&bytes[1]===0&&bytes[2]===113;
}

test('published source contains no literal secrets, home directories, or deployment IPs',async()=>{
  const findings=[];
  for(const name of await files()){
    const relative=path.relative(root,name);
    if(/(?:^|\/)(?:hosts(?:\.local)?\.json|credentials\.json|\.credentials\.yaml|provider\.env|\.env(?:\.[^/]+)?)$/.test(relative)&&!relative.endsWith('.env.example'))
      findings.push(`${relative}:runtime-configuration`);
    if(/(?:^|\/)(?:receipt|deployment-summary|installation-status)\.json$/.test(relative))
      findings.push(`${relative}:deployment-receipt`);
    if(!/\.(?:js|mjs|py|json|md|ya?ml|txt)$/.test(relative))continue;
    const text=await readFile(name,'utf8');
    for(const [index,line]of text.split('\n').entries()){
      if(/(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----)/.test(line))
        findings.push(`${relative}:${index+1}:possible-secret`);
      const literals=[...line.matchAll(/\b(?:apiKey|api_key|secret|password|controlToken|accessToken)\s*[=:]\s*["']([^"'\s]{16,})["']/g)];
      if(literals.some(([,value])=>!/^(?:fixture|dummy|mock|placeholder|example|test|not-a-)/i.test(value)))
        findings.push(`${relative}:${index+1}:possible-secret-assignment`);
      if(!relative.startsWith('test/')){
        const homes=line.match(/\/(?:Users|home|mnt|Volumes)\/[^\s"'`<>]+/g)||[];
        if(homes.some(value=>!isPlaceholderHome(value)))findings.push(`${relative}:${index+1}:absolute-home`);
        const addresses=line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)||[];
        if(addresses.some(value=>!publicAddress(value)))findings.push(`${relative}:${index+1}:deployment-ip`);
      }
    }
  }
  assert.deepEqual(findings,[],`Publication guard rejected file locations (contents suppressed): ${findings.join(', ')}`);
});

test('package ships reusable source and licenses while ignoring runtime material',async()=>{
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  assert.equal(pkg.engines.dsh,'0.2.1-rc.5');
  assert.ok(Array.isArray(pkg.files));
  assert.ok(!pkg.files.some(value=>value==='.'||value==='*'||value.includes('**')||value.startsWith('test/')));
  for(const member of pkg.files){
    const item=await lstat(path.join(root,member));
    assert.ok(!item.isSymbolicLink(),`Release member is a symlink: ${member}`);
    assert.ok(member.endsWith('/')?item.isDirectory():item.isFile(),`Release member has wrong type: ${member}`);
  }
  for(const required of ['README.md','LICENSE','THIRD_PARTY_NOTICES.md','config.example.json','scripts/ssh-browser-cookie.py','licenses/'])
    assert.ok(pkg.files.includes(required),`Missing release member: ${required}`);
  for(const license of ['LICENSE','licenses/DeepSeek-MIT.txt','licenses/clsx-MIT.txt','licenses/dsh-ssh-workspace-MIT.txt']){
    const text=await readFile(path.join(root,license),'utf8');
    assert.match(text,/Permission is hereby granted/);
    assert.match(text,/THE SOFTWARE IS PROVIDED/);
  }
  const ignore=await readFile(path.join(root,'.gitignore'),'utf8');
  for(const item of ['.env','hosts.json','.credentials.yaml','*.sqlite*'])assert.ok(ignore.split('\n').includes(item));
});
