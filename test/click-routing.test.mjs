import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
// Click-path routing (group 1): the global "new session" follows the source on
// screen, and a known local session opens without waiting for remote catalogs.
const read = name => fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const helpers=read('lib/transport.js').replaceAll('export ','');
const source=read('client-main.template.js').replace('/* ROUTING_HELPERS */',helpers).replace('/* PERSISTENT_HELPERS */',read('persistent-parent.template.js')).replace('/* PLUGIN_SYNC */','function createPluginSyncPanel(){return()=>null;}').replace('          const rowStyle =','          globalThis.fixtureOpen = open;\n          const rowStyle =');
const walk=node=>Array.isArray(node)?node.flatMap(walk):!node||typeof node!=='object'?[]:[node,...(node.children||[]).flatMap(walk)];
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));};

async function page({nativeStart,localById={'local-only':{}},catalogGate}={}){
  const registrations=[],effects=[],requests=[],remoteCommands=[],nativeOpens=[],ports=[];
  let panelId=null,selection={sessionId:'local-only'};
  const hosts=['mac','alpha'].map((id,i)=>({id,label:i?'Alpha':'Local',status:'ready',workspaces:[{workspaceId:'w',path:'/p/'+id,title:'P '+id,sessionIds:[i?'remote-one':'local-only']}],items:[{sessionId:i?'remote-one':'local-only',title:'S '+id,blank:false}],archivedSessionIds:[]}));
  const react={createElement:(type,props,...children)=>typeof type==='function'?type({...props,children}):{type,props:props||{},children:children.flat().filter(Boolean)},useSyncExternalStore:(_s,get)=>get(),useState:v=>[v,()=>{}],useEffect:()=>{}};
  const fetch=async(path,options={})=>{
    const body=options.body?JSON.parse(options.body):undefined;requests.push({path,body});
    if(path==='/api/dsh-unified/catalog'){ if(catalogGate) await catalogGate.promise; return {ok:true,json:async()=>({ok:true,hosts})}; }
    if(/\/hosts\/alpha\/embed\/bootstrap$/.test(path))return {ok:true,json:async()=>({ok:true,value:{frameId:'f-alpha',frameUrl:'http://127.0.0.1:39880/?bootstrap=x',frameOrigin:'http://127.0.0.1:39880',controlToken:'tok-alpha',expiresAt:Date.now()+1e6}})};
    if(/\/embed\/(refresh|close)$/.test(path))return {ok:true,json:async()=>({ok:true,value:{}})};
    throw Error('unexpected '+path);
  };
  const service={selection:{getSnapshot:()=>selection,subscribe:()=>()=>{}},sessions:{refresh:async()=>{},list:{getSnapshot:()=>({phase:'ready',byId:localById})}},openSession:async id=>{nativeOpens.push(id);selection={sessionId:id};},startSession:nativeStart};
  const ui={slots:{inject:(_n,fn)=>fn(),register:(o,c)=>{registrations.push({options:o,component:c});return()=>{};}},effect:fn=>effects.push(fn),layout:{toggleSidebar(){},selectPanel:id=>{panelId=id;},panelInfo:{getSnapshot:()=>({activePanelId:panelId}),subscribe:()=>()=>{}}},uiWorkspace:service,locale:{getSnapshot:()=>({active:'zh-CN'})}};
  const env={console,URL,Promise,MessageChannel,AbortController,Set,Map,Error,JSON,Uint8Array,Date,crypto:{randomUUID:()=>'req-abcdefghijklmnop'},setTimeout:(fn,ms)=>setTimeout(fn,ms===300?2:ms),clearTimeout,setInterval:()=>1,clearInterval(){},__DSH_UNIFIED_PERSISTENT_LOCAL__:true,sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},document:{visibilityState:'visible',documentElement:{},addEventListener(){},removeEventListener(){},querySelector:()=>null}};
  let plugin;env.window={fetch,innerWidth:1400,location:{origin:'dsh-app://app',reload(){throw Error('no reload expected');}},__ModuleLoader__:{load:v=>{plugin=v.factory(()=>react);}}};
  vm.runInNewContext(source,env);plugin.apply({inject:(_d,fn)=>fn(ui)});const cleanups=effects.map(fn=>fn());
  if(!catalogGate) await settle();
  const overlay=()=>registrations.find(r=>r.options.name==='shell.overlay').component();
  function attach(){for(const node of walk(overlay()).filter(n=>n.type==='iframe')){if(node.__attached)continue;node.__attached=true;node.props.ref({focus(){},contentWindow:{postMessage(msg,origin,transfer){const port=transfer[0];ports.push(port);port.on('message',v=>{remoteCommands.push(v);port.postMessage({id:v.id,ok:true,value:{frameId:'f-alpha',sessionId:'remote-one'}});});port.postMessage({type:'ready',frameId:'f-alpha',sessionId:'remote-one'});}}});}}
  async function showRemote(){const p=env.fixtureOpen('alpha','remote-one','w');await settle();attach();await p;await settle();}
  return {env,service,requests,remoteCommands,nativeOpens,setPanel:v=>{panelId=v;},showRemote,close:()=>{cleanups.forEach(fn=>fn?.());ports.forEach(p=>p.close());}};
}

test('global new-session buttons follow the source on screen and never fall back to the local Host',async()=>{
  const nativeCalls=[];
  const p=await page({nativeStart(...args){nativeCalls.push(args);}});
  // Mac on screen: native behaviour, unchanged.
  p.service.startSession();assert.equal(nativeCalls.length,1);
  await p.showRemote();
  // Remote on screen (sidebar button / titlebar button both call this with no args).
  p.service.startSession();await settle();
  assert.equal(nativeCalls.length,1,'local Host must not create while a remote source is shown');
  assert.equal(p.remoteCommands.filter(c=>c.type==='session/new').length,1);
  // An explicit workspace (native per-workspace "+") keeps native semantics.
  p.service.startSession('w');assert.equal(nativeCalls.length,2);
  // A panel (automation, settings…) covers the remote: its "new task" means this page's Host.
  p.setPanel('schedule');p.service.startSession();await settle();
  assert.equal(nativeCalls.length,3);assert.equal(p.remoteCommands.filter(c=>c.type==='session/new').length,1);
  p.setPanel(null);
  // Back to Mac: native again.
  await p.env.fixtureOpen('mac','local-only','w');await settle();
  p.service.startSession();assert.equal(nativeCalls.length,4);
  assert.equal(p.remoteCommands.filter(c=>c.type==='session/new').length,1);
  p.close();
  assert.equal(typeof p.service.startSession,'function');
});

test('the routing wrapper is removed on dispose and restores the native method',async()=>{
  const native=function(){};
  const p=await page({nativeStart:native});
  assert.notEqual(p.service.startSession,native);
  p.close();
  assert.equal(p.service.startSession,native);
});

test('a session the local controller already lists opens without waiting for remote catalogs',async()=>{
  let release;const catalogGate={promise:new Promise(r=>{release=r;})};
  const p=await page({nativeStart(){},catalogGate});
  // Catalog (all Hosts) is stalled, as when a remote is slow.
  const opening=p.env.fixtureOpen('mac','local-only','w');
  await settle();
  assert.deepEqual(p.nativeOpens,[],'cannot open yet: the sidebar has never listed this row');
  release();await opening;await settle();
  assert.deepEqual(p.nativeOpens,['local-only']);
  p.close();
});

test('with a listed row, a stalled remote catalog does not delay opening a known local session',async()=>{
  const p=await page({nativeStart(){}});
  // Rows are known; the 10-second freshness window has expired, so before this
  // change a click would wait for a full multi-Host catalog read.
  const realNow=Date.now;let shift=0;Date.now=()=>realNow()+shift;
  try{
    shift=60_000;
    const before=p.requests.filter(r=>r.path==='/api/dsh-unified/catalog').length;
    await p.env.fixtureOpen('mac','local-only','w');
    assert.deepEqual(p.nativeOpens,['local-only']);
    assert.equal(p.requests.filter(r=>r.path==='/api/dsh-unified/catalog').length,before,'no blocking multi-Host catalog read before a local open');
  } finally { Date.now=realNow; }
  p.close();
});

test('an unknown local session still requires a fresh catalog read (no weaker check)',async()=>{
  const p=await page({nativeStart(){},localById:{}});
  const realNow=Date.now;let shift=0;Date.now=()=>realNow()+shift;
  try{
    shift=60_000;
    const catalogReads=()=>p.requests.filter(r=>r.path==='/api/dsh-unified/catalog').length;
    const before=catalogReads();
    await p.env.fixtureOpen('mac','local-only','w');await settle();
    assert.deepEqual(p.nativeOpens,['local-only']);
    assert.equal(catalogReads(),before+1);
  } finally { Date.now=realNow; }
  p.close();
});

// A parent-named Workspace is honoured (group 4): the capability already existed
// via the management session-create allowlist, so this is not new authority. The
// frame still owns creation, and an unnamed request keeps the native no-argument
// action the titlebar button depends on.
test('companion session/new keeps the no-argument action and validates a named workspace',async()=>{
  let plugin,listen,effect;const starts=[],replies=[],panels=[],parent={};
  const boot={frameId:'f',controlToken:'t',parentOrigin:'dsh-app://app',hostId:'alpha'};
  const env={console,Promise,Error,JSON,__DSH_EMBED_BOOT__:boot,document:{querySelector:()=>null,createElement:()=>({remove(){}}),documentElement:{},head:{appendChild(){}}}};
  env.window={parent,addEventListener:(_t,fn)=>listen=fn,removeEventListener(){},__ModuleLoader__:{load:v=>plugin=v.factory(()=>{})}};
  vm.runInNewContext(read('companion.template.js'),env);
  plugin.apply({uiWorkspace:{selection:{getSnapshot:()=>({sessionId:'s'}),subscribe:()=>()=>{}},startSession:(...a)=>starts.push(a),openSession(){}},sessions:{list:{getSnapshot:()=>({phase:'ready',byId:{}})}},layout:{toggleSidebar(){},selectPanel:v=>panels.push(v)},effect:fn=>effect=fn});
  const cleanup=effect();const port={start(){},close(){},postMessage:v=>replies.push(v)};
  listen({source:parent,origin:boot.parentOrigin,data:{type:'dsh-unified/embed-init',frameId:'f',controlToken:'t'},ports:[port]});
  port.onmessage({data:{id:'n0',type:'session/new'}});await settle();
  assert.deepEqual(starts,[[]],'an unnamed request keeps the native no-argument action');
  assert.equal(replies.find(r=>r.id==='n0').ok,true);
  port.onmessage({data:{id:'n1',type:'session/new',workspaceId:'injected'}});await settle();
  assert.deepEqual(starts.at(-1),['injected'],'a named workspace is passed through');
  assert.equal(replies.find(r=>r.id==='n1').ok,true);
  port.onmessage({data:{id:'n2',type:'session/new',workspaceId:'bad workspace'}});await settle();
  assert.equal(replies.find(r=>r.id==='n2').ok,false,'an invalid workspace identity is refused');
  assert.equal(starts.length,2,'a refused identity never reaches the native action');
  assert.equal(panels.at(-1),null);
  cleanup();
});
