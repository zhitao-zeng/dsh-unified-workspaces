import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {validHostId, routeUrl, muxPath, appearanceRoute, hostApiPrefix, absoluteWorkspacePath} from '../lib/transport.js';
const boot = fs.readFileSync(new URL('../lib/boot.js', import.meta.url), 'utf8');
const device = 'fixture-device-abcdefghijklmnop';
function browser(host, page = 'https://remote.example.test/pair-app', storageEntries = [], bootConfig, nativeSelection) {
  const records = [], storage = new Map([['dsh-unified-host', host], ['dsh-remote-device', device], ...storageEntries]);
  const nativeStorage = new Map(nativeSelection ? [['dsh.sessions.current', JSON.stringify(nativeSelection)]] : []);
  class Socket { constructor(url) { records.push({type:'socket',url:String(url)}); } }
  const env = {URL, Request, Response, Headers, AbortSignal, MessageEvent, TransformStream, TextEncoder, TextDecoder,
    location:new URL(page), document:{baseURI:page},
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},
    localStorage:{getItem:key=>nativeStorage.get(key)??null,setItem:(key,value)=>nativeStorage.set(key,String(value))},
    fetch:async (url, options)=>{records.push({type:'http',url:String(url),options});return Response.json({ok:true});},
    WebSocket:Socket,
    __DSH_BOOT__:{rev:'fixture',entries:[{id:'@deepseek-ai/dsh-api-gateway'},{id:'@zhitao-zeng/dsh-unified-workspaces'},{id:'unrelated-plugin'}],batches:[{entries:['@deepseek-ai/dsh-api-gateway','@zhitao-zeng/dsh-unified-workspaces','unrelated-plugin']}]},
  };
  env.__DSH_UNIFIED_BOOT_CONFIG__=bootConfig;
  env.window=env; vm.createContext(env); vm.runInContext(boot,env);
  return {env,records,storage,nativeStorage};
}
test('routing binds API, appearance and both native mux variants to the chosen remote',()=>{
  for (const host of ['alpha','beta-2']) {
    assert(validHostId(host,false));
    const api=hostApiPrefix(host);
    for (const path of ['/api/session/list','/remote/api/session/list']) assert.equal(new URL(routeUrl(path,'https://remote.example.test/',host)).pathname,(path.startsWith('/remote/')?'/remote':'')+api+'/native/session/list');
    for (const path of ['/dsh-prompt-predict/status?sessionId=shared-id','/remote/dsh-prompt-predict/suggest']) assert.equal(new URL(routeUrl(path,'https://remote.example.test/',host)).pathname,(path.startsWith('/remote/')?'/remote':'')+api+'/native/_host/dsh-prompt-predict/'+(path.includes('/suggest')?'suggest':'status'));
    for (const path of ['/api/remote.mux','/remote/api/remote.mux']) assert.equal(new URL(muxPath(path,device,host),'https://remote.example.test').pathname,'/dsh-unified/hosts/'+host+'/remote.mux');
    const target=appearanceRoute('/api/settings/describe','https://remote.example.test/','',host);
    assert.equal(new URL(target).pathname,api+'/appearance/describe');
    const model=JSON.stringify({type:'client-request',method:'settings/mutate',payload:{args:{ns:'llm-pi-ai'}}});
    assert.equal(appearanceRoute('/api/settings/mutate','https://remote.example.test/',model,host),undefined);
    assert.equal(routeUrl('https://foreign.example.test/api/session/list','https://remote.example.test/',host),'https://foreign.example.test/api/session/list');
    assert.equal(routeUrl('/api/dsh-unified/catalog','https://remote.example.test/',host),'/api/dsh-unified/catalog');
  }
  for (const bad of ['__proto__','constructor','prototype','../other','a/b','',null]) assert.equal(validHostId(bad),false);
  assert.equal(validHostId('mac',false),false);
});
test('phone boot routes independently to arbitrary hosts, preserves pairing and blocks local-only plugin sockets',async()=>{
  for (const host of ['alpha','beta-2']) {
    const {env,records}=browser(host);
    assert.equal(env.__DSH_UNIFIED_REMOTE_BOOT__.selectedHost,host);
    await env.fetch('/api/session/list',{method:'POST',body:'{}'});
    const req=records.find(row=>row.type==='http');
    assert.equal(new URL(req.url).pathname,'/remote/api/dsh-unified/hosts/'+host+'/native/session/list');
    assert.equal(new Headers(req.options.headers).get('x-dsh-remote-device'),device);
    await env.fetch('./dsh-prompt-predict/suggest',{method:'POST',headers:{'content-type':'application/json','x-dsh-locale':'zh'},body:JSON.stringify({sessionId:'remote-existing'})});
    const suggestion=records.at(-1);assert.equal(new URL(suggestion.url).pathname,'/remote/api/dsh-unified/hosts/'+host+'/native/_host/dsh-prompt-predict/suggest');assert.equal(new Headers(suggestion.options.headers).get('x-dsh-remote-device'),device);
    for (const path of ['/api/remote.mux','/remote/api/remote.mux']) {
      new env.WebSocket('wss://remote.example.test'+path);
      const out=new URL(records.at(-1).url);assert.equal(out.pathname,'/dsh-unified/hosts/'+host+'/remote.mux');assert.equal(out.searchParams.get('device'),device);
    }
    for(const path of ['/sidebar/ws/terminal','/remote/sidebar/ws/terminal']) assert.throws(()=>new env.WebSocket('wss://remote.example.test'+path));
    new env.WebSocket('wss://foreign.example.test/api/remote.mux');assert.equal(records.at(-1).url,'wss://foreign.example.test/api/remote.mux');
  }
  const local=browser('mac');new local.env.WebSocket('wss://remote.example.test/remote/api/remote.mux');assert.equal(local.records.at(-1).url,'wss://remote.example.test/remote/api/remote.mux');assert.equal(local.env.__DSH_UNIFIED_REMOTE_BOOT__,undefined);
});
test('desktop startup restores only local selection; phone preserves qualified identical IDs',()=>{
  const selections=JSON.stringify({mac:{sessionId:'local-id'},alpha:{sessionId:'shared-id'},beta:{sessionId:'shared-id'}});
  const desktop=browser('alpha','dsh-app://app/',[['dsh-unified-selection-by-host',selections],['dsh-unified-pending-selection',JSON.stringify({host:'beta',sessionId:'shared-id'})]]);
  assert.equal(desktop.storage.get('dsh-unified-host'),'mac');assert.equal(JSON.parse(desktop.nativeStorage.get('dsh.sessions.current')).sessionId,'local-id');assert.equal(desktop.env.__DSH_UNIFIED_PERSISTENT_LOCAL__,true);assert.equal(desktop.storage.has('dsh-unified-pending-selection'),false);
  const phone=browser('alpha','https://remote.example.test/pair-app',[['dsh-unified-selection-by-host',selections],['dsh-unified-pending-selection',JSON.stringify({host:'beta',sessionId:'shared-id'})]]);
  assert.equal(phone.storage.get('dsh-unified-host'),'beta');assert.equal(phone.env.__DSH_UNIFIED_REMOTE_BOOT__.selectedHost,'beta');assert.equal(JSON.parse(phone.nativeStorage.get('dsh.sessions.current')).sessionId,'shared-id');
});

test('workspace paths accept native POSIX, drive and UNC absolutes while rejecting drive-relative paths',()=>{
  for(const path of ['/srv/project','C:\\projects\\app','D:/projects/app','\\\\server\\share\\project']) assert.equal(absoluteWorkspacePath(path),true,path);
  for(const path of ['relative','C:relative','\\relative','/bad\0name','']) assert.equal(absoluteWorkspacePath(path),false,path);
});


test('legacy phone and desktop selections migrate only to an explicitly configured remote',()=>{
  const old=[['gpu16-native-host','gpu16'],['gpu16-native-selection-by-host',JSON.stringify({mac:{sessionId:'local-existing'},gpu16:{sessionId:'remote-existing'}})]];
  const config={hostIds:['alpha','beta'],legacyHostId:'alpha'};
  const phone=browser(null,'https://remote.example.test/pair-app',old,config,{sessionId:'remote-existing'});
  assert.equal(phone.storage.get('dsh-unified-host'),'alpha');
  assert.equal(phone.env.__DSH_UNIFIED_REMOTE_BOOT__.selectedHost,'alpha');
  assert.equal(JSON.parse(phone.nativeStorage.get('dsh.sessions.current')).sessionId,'remote-existing');
  new phone.env.WebSocket('wss://remote.example.test/remote/api/remote.mux');
  assert.equal(new URL(phone.records.at(-1).url).pathname,'/dsh-unified/hosts/alpha/remote.mux');
  const desktop=browser(null,'dsh-app://app/',old,config,{sessionId:'remote-existing'});
  assert.equal(desktop.storage.get('dsh-unified-host'),'mac');
  assert.equal(JSON.parse(desktop.nativeStorage.get('dsh.sessions.current')).sessionId,'local-existing');
  assert.equal(desktop.env.__DSH_UNIFIED_REMOTE_BOOT__,undefined);
  assert.throws(()=>browser(null,'https://remote.example.test/pair-app',old,undefined,{sessionId:'remote-existing'}));
  assert.throws(()=>browser(null,'https://remote.example.test/pair-app',old,{hostIds:['beta'],legacyHostId:'alpha'},{sessionId:'remote-existing'}));
  const current=browser('beta','https://remote.example.test/pair-app',old,config,{sessionId:'beta-existing'});
  assert.equal(current.storage.get('dsh-unified-host'),'beta');
  assert.equal(current.env.__DSH_UNIFIED_LEGACY_MIGRATED__,undefined);
});
