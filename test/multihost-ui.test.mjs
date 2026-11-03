import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
const read = name => fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const helpers=read('lib/transport.js').replaceAll('export ','');
const source=read('client-main.template.js').replace('/* ROUTING_HELPERS */',helpers).replace('/* PERSISTENT_HELPERS */',read('persistent-parent.template.js')).replace('          const rowStyle =','          globalThis.fixtureOpen = open;\n          const rowStyle =');
const walk=node=>Array.isArray(node)?node.flatMap(walk):!node||typeof node!=='object'?[]:[node,...(node.children||[]).flatMap(walk)];
const find=(tree,predicate)=>{const found=walk(tree).find(predicate);assert(found,'expected UI element');return found;};
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));};
test('local and two remote workspaces with identical session IDs retain independent native contexts',async()=>{
  const registrations=[],effects=[],requests=[],nativeOpens=[],remoteOpens=[],ports=[];
  const metadataByHost=new Map(),frameByHost=new Map();
  let selection={sessionId:'local-only'},panelId=null,reloads=0,collapsed=false,toggleCount=0;
  const hosts=['mac','alpha','beta'].map((id,index)=>({id,label:index?'Server '+index:'Local',status:'ready',workspaces:[{workspaceId:'shared-workspace',path:'/projects/'+id,title:'Project '+id,sessionIds:[index?'shared-session':'local-only']}],items:[{sessionId:index?'shared-session':'local-only',title:'Session '+id,blank:false}],archivedSessionIds:[]}));
  const storage=new Map([['dsh-unified-host','mac']]);
  const react={createElement:(type,props,...children)=>typeof type==='function'?type({...props,children}):{type,props:props||{},children:children.flat().filter(Boolean)},useSyncExternalStore:(_s,get)=>get(),useState:value=>[typeof value==='boolean'&&collapsed?true:value,()=>{}],useEffect:()=>{}};
  const fetch=async(path,options={})=>{
    const body=options.body?JSON.parse(options.body):undefined;requests.push({path,body});
    if(path==='/api/dsh-unified/catalog')return {ok:true,json:async()=>({ok:true,hosts})};
    const match=/^\/api\/dsh-unified\/hosts\/(alpha|beta)\/embed\/(bootstrap|close)$/.exec(path);
    if(match){
      const id=match[1];let value={};
      if(match[2]==='bootstrap'){
        assert.equal(body.sessionId,'shared-session');
        const origin='http://127.0.0.1:'+(id==='alpha'?39880:39881);
        value={frameId:'frame-'+id,frameUrl:origin+'/?bootstrap=fixture-'+id,frameOrigin:origin,controlToken:'fixture-token-'+id,expiresAt:Date.now()+1200000};metadataByHost.set(id,value);
      }
      return {ok:true,json:async()=>({ok:true,value})};
    }
    if(path==='/api/dsh-unified/manage/session-create'){
      assert.equal(body.host,'beta');const host=hosts.find(h=>h.id==='beta');host.items.push({sessionId:'new-beta',blank:true});host.workspaces[0].sessionIds.push('new-beta');return {ok:true,json:async()=>({ok:true,value:{sessionId:'new-beta'}})};
    }
    throw Error('unexpected fixture request '+path);
  };
  const ui={slots:{inject:(_n,fn)=>fn(),register:(options,component)=>{if(['shell.overlay','sidebar.panellist','sidebar.footer.action'].includes(options.name)){assert.equal(typeof options.id,'string');assert.equal(options.key,undefined);}registrations.push({options,component});return()=>{};}},effect:fn=>effects.push(fn),layout:{toggleSidebar:()=>toggleCount++,selectPanel:id=>{panelId=id;},panelInfo:{getSnapshot:()=>({activePanelId:panelId}),subscribe:()=>()=>{}}},uiWorkspace:{selection:{getSnapshot:()=>selection,subscribe:()=>()=>{}},sessions:{refresh:async()=>{}},openSession:id=>{assert.equal(id,'local-only','remote IDs never reach the local controller');nativeOpens.push(id);selection={sessionId:id};}}};
  const env={console,URL,Promise,MessageChannel,AbortController,Set,Map,Error,JSON,Uint8Array,crypto:{randomUUID:()=> 'fixture-request-abcdefghijklmn'},setTimeout:(fn,ms)=>setTimeout(fn,ms===300?2:ms),clearTimeout,setInterval:()=>1,clearInterval:()=>{},__DSH_UNIFIED_PERSISTENT_LOCAL__:true,sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value))},document:{visibilityState:'visible',documentElement:{},addEventListener(){},removeEventListener(){},querySelector:()=>null}};
  let plugin;env.window={fetch,innerWidth:1400,location:{origin:'dsh-app://app',reload:()=>reloads++},__ModuleLoader__:{load:value=>{plugin=value.factory(()=>react);}}};
  vm.runInNewContext(source,env);plugin.apply({inject:(_deps,fn)=>fn(ui)});const cleanups=effects.map(fn=>fn());await settle();
  const sidebar=()=>registrations.find(r=>r.options.name==='sidebar.workspaces').component({wide:true});
  const overlay=()=>registrations.find(r=>r.options.name==='shell.overlay').component();
  const manager=()=>registrations.find(r=>r.options.name==='main').component();
  const project=id=>find(sidebar(),n=>n.props['data-flat-workspace-row']&&n.props['data-host-id']===id);
  const row=id=>find(sidebar(),n=>n.props['data-row-key']==='session:'+(id==='mac'?'local-only':'shared-session')&&n.props['data-host-id']===id);
  function attachNewFrames(){for(const node of walk(overlay()).filter(n=>n.type==='iframe')){const hostId=node.props['data-host-id'];if(frameByHost.has(hostId))continue;const meta=metadataByHost.get(hostId);const frame={focus(){},contentWindow:{postMessage(message,origin,transfer){assert.equal(origin,meta.frameOrigin);assert.equal(message.type,'dsh-unified/embed-init');assert.equal(message.controlToken,meta.controlToken);const port=transfer[0];ports.push(port);port.on('message',value=>{if(value.type==='session/open')remoteOpens.push({hostId,sessionId:value.sessionId});port.postMessage({id:value.id,ok:true,value:{frameId:meta.frameId,sessionId:value.sessionId||'shared-session'}});});port.postMessage({type:'ready',frameId:meta.frameId,sessionId:'shared-session'});}}};frameByHost.set(hostId,{frame,src:node.props.src,key:node.props.key});node.props.ref(frame);}}
  async function open(id){if(!walk(sidebar()).some(n=>n.props['data-row-key']==='session:'+(id==='mac'?'local-only':'shared-session')&&n.props['data-host-id']===id))find(project(id),n=>n.props['data-action']==='open-workspace').props.onClick();await settle();const promise=row(id).props.onClick();await settle();attachNewFrames();await promise;await settle();}
  assert.deepEqual(walk(sidebar()).filter(n=>n.props['data-flat-workspace-row']).map(n=>n.props['data-host-id']),['mac','alpha','beta']);
  for(const id of ['alpha','beta'])find(project(id),n=>n.props['data-action']==='open-workspace').props.onClick();
  assert.equal(requests.filter(r=>r.path.includes('/embed/')).length,0,'project titles only expand');
  await open('alpha');await open('beta');
  assert.equal(frameByHost.size,2);
  for(let i=0;i<10;i++){await open('mac');assert(walk(overlay()).filter(n=>n.props['data-persistent-remote-overlay']).every(n=>n.props.style.display==='none'));await open('alpha');await open('beta');}
  assert.equal(reloads,0);assert.equal(requests.filter(r=>r.path.endsWith('/embed/bootstrap')).length,2);
  const frames=walk(overlay()).filter(n=>n.type==='iframe');assert.equal(frames.length,2);
  for(const node of frames){const saved=frameByHost.get(node.props['data-host-id']);assert.equal(node.props.src,saved.src);assert.equal(node.props.key,saved.key);}
  assert.equal(walk(overlay()).filter(n=>n.props['data-persistent-remote-overlay']&&n.props.style.display==='block').length,1);
  assert.equal(selection.sessionId,'local-only');assert.equal(nativeOpens.length,10);
  for(const id of ['alpha','beta'])assert(remoteOpens.some(row=>row.hostId===id&&row.sessionId==='shared-session'));
  const stableSources=frames.map(n=>n.props.src);
  for(const panel of ['settings','dsh-unified-host']){panelId=panel;assert(walk(overlay()).filter(n=>n.props['data-persistent-remote-overlay']).every(n=>n.props.style.display==='none'));assert.deepEqual(walk(overlay()).filter(n=>n.type==='iframe').map(n=>n.props.src),stableSources);}
  panelId=null;collapsed=true;find(overlay(),n=>n.props['data-action']==='expand-parent-workspaces').props.onClick();assert.equal(toggleCount,1);collapsed=false;
  await assert.rejects(env.fixtureOpen('unconfigured','shared-session'),/暂时无法打开/);assert.equal(requests.filter(r=>r.path.includes('/hosts/unconfigured/')).length,0);
  find(project('beta'),n=>n.props['data-action']==='new-session').props.onClick();await settle();assert.equal(panelId,'dsh-unified-host');
  await find(manager(),n=>n.type==='form').props.onSubmit({preventDefault(){}});await settle();assert.equal(remoteOpens.some(r=>r.sessionId==='new-beta'),false);
  await find(manager(),n=>n.type==='button'&&n.children.includes('打开刚创建的会话')).props.onClick();await settle();assert.deepEqual(remoteOpens.at(-1),{hostId:'beta',sessionId:'new-beta'});
  assert.equal(requests.filter(r=>r.path.endsWith('/embed/bootstrap')).length,2);
  cleanups.forEach(fn=>fn?.());ports.forEach(port=>port.close());
});
test('companion rejects another source/window/origin/token and accepts only known sessions',async()=>{
  let plugin,listen,effect,selected='shared-session',toggles=0;
  const opened=[],replies=[],parent={},other={};
  const boot={frameId:'frame-alpha',controlToken:'alpha-control',parentOrigin:'dsh-app://app',hostId:'alpha'};
  const env={console,Promise,Error,JSON,__DSH_EMBED_BOOT__:boot,document:{querySelector:()=>null,createElement:()=>({remove(){}}),documentElement:{},head:{appendChild(){}}}};
  env.window={parent,addEventListener:(_t,fn)=>listen=fn,removeEventListener(){},__ModuleLoader__:{load:value=>plugin=value.factory(()=>{})}};
  vm.runInNewContext(read('companion.template.js'),env);plugin.apply({uiWorkspace:{selection:{getSnapshot:()=>({sessionId:selected}),subscribe:()=>()=>{}},openSession:id=>{selected=id;opened.push(id);}},sessions:{refresh:async()=>{},list:{getSnapshot:()=>({phase:'ready',byId:{'shared-session':{},'alpha-next':{}}})}},layout:{toggleSidebar:()=>toggles++,selectPanel(){}},effect:fn=>effect=fn});const cleanup=effect();
  const port={start(){},close(){},postMessage:value=>replies.push(value)},init={type:'dsh-unified/embed-init',frameId:boot.frameId,controlToken:boot.controlToken};
  for(const event of [{source:other,origin:boot.parentOrigin,data:init},{source:parent,origin:'https://other.example.test',data:init},{source:parent,origin:boot.parentOrigin,data:{...init,frameId:'frame-beta'}},{source:parent,origin:boot.parentOrigin,data:{...init,controlToken:'beta-control'}}]){listen({...event,ports:[port]});assert.equal(port.onmessage,undefined);}
  listen({source:parent,origin:boot.parentOrigin,data:init,ports:[port]});assert.equal(replies[0].type,'ready');
  for(const id of ['foreign-session','__proto__']){port.onmessage({data:{id,type:'session/open',sessionId:id}});await settle();assert.equal(replies.find(r=>r.id===id).ok,false);}
  port.onmessage({data:{id:'good',type:'session/open',sessionId:'alpha-next'}});await settle();assert.deepEqual(opened,['alpha-next']);cleanup();
});
