import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
// Sidebar parity pass (group 2): workspace titles carry the machine name, the
// project row exposes hover-only 24x24 actions, session rows show a relative
// timestamp, each project collapses to five rows, and the header is "新建任务".
const read = name => fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const helpers=read('lib/transport.js').replaceAll('export ','');
const source=read('client-main.template.js').replace('/* ROUTING_HELPERS */',helpers).replace('/* PERSISTENT_HELPERS */',read('persistent-parent.template.js')).replace('/* PLUGIN_SYNC */','function createPluginSyncPanel(){return()=>null;}').replace('          const rowStyle =','          globalThis.fixtureRelativeTime = relativeTime;\n          const rowStyle =');
const walk=node=>Array.isArray(node)?node.flatMap(walk):!node||typeof node!=='object'?[]:[node,...(node.children||[]).flatMap(walk)];
const text=node=>walk(node).flatMap(n=>n.children).filter(child=>typeof child==='string'||typeof child==='number').join('');
const find=(tree,predicate)=>{const found=walk(tree).find(predicate);assert(found,'expected UI element');return found;};
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));};
const sessionRows=tree=>walk(tree).filter(n=>typeof n.props['data-row-key']==='string'&&n.props['data-row-key'].startsWith('session:'));

function sessions(count){const now=Date.now();return Array.from({length:count},(_,index)=>({sessionId:'s'+(index+1),title:'任务 '+(index+1),blank:false,updatedAt:now-(index+1)*60_000}));}
function host(id,label,items,workspaceId='w1'){return {id,label,status:'ready',workspaces:[{workspaceId,path:'/projects/demo',title:'demo',sessionIds:items.map(item=>item.sessionId)}],items,archivedSessionIds:[],pinnedSessionIds:[]};}

async function page({hosts,selection={sessionId:'none'},persistent=true,nativeStart}={}){
  const registrations=[],effects=[],requests=[],calls=[];
  const storage=new Map();
  const react={createElement:(type,props,...children)=>typeof type==='function'?type({...props,children}):{type,props:props||{},children:children.flat().filter(Boolean)},useSyncExternalStore:(_s,get)=>get(),useState:value=>[value,()=>{}],useEffect:()=>{}};
  const fetch=async (path,options={})=>{
    requests.push({path,body:options.body});
    if(path==='/api/dsh-unified/catalog')return {ok:true,json:async()=>({ok:true,hosts})};
    throw Error('unexpected fixture request '+path);
  };
  const recorder={value:undefined};
  const service={selection:{getSnapshot:()=>selection,subscribe:()=>()=>{}},sessions:{refresh:async()=>{},list:{getSnapshot:()=>({phase:'ready',byId:{}})}},openSession:async()=>{},startSession:(...args)=>{calls.push(args);recorder.value?.(...args);}};
  if(nativeStart)recorder.value=nativeStart;
  const ui={slots:{inject:(_n,fn)=>fn(),register:(options,component)=>{registrations.push({options,component});return()=>{};}},effect:fn=>effects.push(fn),layout:{toggleSidebar(){},selectPanel(){},panelInfo:{getSnapshot:()=>({activePanelId:null}),subscribe:()=>()=>{}}},uiWorkspace:service,locale:{getSnapshot:()=>({active:'zh-CN'})}};
  const env={console,URL,Promise,MessageChannel,AbortController,Set,Map,Error,JSON,Uint8Array,Date,crypto:{randomUUID:()=>'req-abcdefghijklmnop'},setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},document:{visibilityState:'visible',documentElement:{},addEventListener(){},removeEventListener(){},querySelector:()=>null}};
  if(persistent)env.__DSH_UNIFIED_PERSISTENT_LOCAL__=true;
  let plugin;env.window={fetch,innerWidth:1400,location:{origin:'dsh-app://app',reload(){throw Error('no reload expected');}},__ModuleLoader__:{load:value=>{plugin=value.factory(()=>react);}}};
  vm.runInNewContext(source,env);plugin.apply({inject:(_deps,fn)=>fn(ui)});const cleanups=effects.map(fn=>fn());await settle();
  const sidebar=()=>registrations.find(r=>r.options.name==='sidebar.workspaces').component({wide:true});
  const expand=()=>{find(sidebar(),n=>n.props['data-action']==='open-workspace').props.onClick();return sidebar();};
  return {env,ui,service,requests,calls,selection,sidebar,expand,close:()=>cleanups.forEach(fn=>fn?.())};
}

test('relativeTime covers every boundary and never renders NaN',async()=>{
  const p=await page({hosts:[host('mac','本机',[])]});
  const relativeTime=p.env.fixtureRelativeTime;
  assert.equal(typeof relativeTime,'function');
  const now=1_700_000_000_000;
  assert.equal(relativeTime(now,now),'刚刚');
  assert.equal(relativeTime(now-59_000,now),'刚刚');
  assert.equal(relativeTime(now-60_000,now),'1分');
  assert.equal(relativeTime(now-(59*60+59)*1_000,now),'59分');
  assert.equal(relativeTime(now-3_600_000,now),'1小时');
  assert.equal(relativeTime(now-23*3_600_000,now),'23小时');
  assert.equal(relativeTime(now-86_400_000,now),'1天');
  assert.equal(relativeTime(now-29*86_400_000,now),'29天');
  const monthDay=ms=>{const date=new Date(ms);return (date.getMonth()+1)+'月'+date.getDate()+'日';};
  assert.equal(relativeTime(now-30*86_400_000,now),monthDay(now-30*86_400_000));
  assert.equal(relativeTime(now+1_000,now),'刚刚','future clock skew reads as just now');
  assert.equal(relativeTime(now+86_400_000,now),'刚刚');
  for(const value of [undefined,null,NaN,'123',0,-1,-86_400_000,Infinity])assert.equal(relativeTime(value,now),'','invalid timestamps render nothing');
  p.close();
});

test('a project shows five sessions plus "显示更多" until it is expanded',async()=>{
  const p=await page({hosts:[host('mac','本机',sessions(8))]});
  const tree=p.expand();
  assert.deepEqual(sessionRows(tree).map(n=>n.props['data-row-key']),['session:s1','session:s2','session:s3','session:s4','session:s5']);
  const more=find(tree,n=>n.props['data-action']==='show-more');
  assert.equal(text(more),'显示更多');
  assert.equal(more.props['aria-label'],'显示更多，还有 3 条');
  assert.equal(more.props['data-host-id'],'mac');
  assert.equal(more.props['data-workspace-id'],'w1');
  more.props.onClick();
  const expanded=p.sidebar();
  assert.deepEqual(sessionRows(expanded).map(n=>n.props['data-row-key']),['session:s1','session:s2','session:s3','session:s4','session:s5','session:s6','session:s7','session:s8']);
  assert.equal(walk(expanded).filter(n=>n.props['data-action']==='show-more').length,0);
  p.close();
});

test('the session on screen stays visible while the project is collapsed',async()=>{
  const p=await page({hosts:[host('mac','本机',sessions(8))],selection:{sessionId:'s7'}});
  const tree=p.expand();
  const rows=sessionRows(tree);
  assert.deepEqual(rows.map(n=>n.props['data-row-key']),['session:s1','session:s2','session:s3','session:s4','session:s5','session:s7']);
  const current=rows.find(n=>n.props['data-row-key']==='session:s7');
  assert.equal(current.props['aria-current'],'page');
  assert.equal(text(find(tree,n=>n.props['data-action']==='show-more')),'显示更多');
  p.close();
});

test('workspace titles carry the machine name and drop the remote badge',async()=>{
  const p=await page({hosts:[host('mac','本机',[]),host('alpha','Alpha · 测试',[])]});
  const tree=p.sidebar();
  const project=id=>find(tree,n=>n.props['data-flat-workspace-row']&&n.props['data-host-id']===id);
  const opener=id=>find(project(id),n=>n.props['data-action']==='open-workspace');
  assert.match(text(opener('mac')),/demo · 本机$/);
  assert.equal(opener('mac').props.title,'/projects/demo · 本机');
  assert.match(text(opener('alpha')),/demo · Alpha$/);
  assert.equal(opener('alpha').props.title,'/projects/demo · Alpha · 测试');
  assert.equal(walk(tree).filter(n=>n.props['data-remote-workspace-badge']).length,0);
  p.close();
});

test('the header "新建任务" calls startSession with no arguments and no shortcut hint',async()=>{
  const starts=[];
  const p=await page({hosts:[host('mac','本机',[])],persistent:false,nativeStart:(...args)=>starts.push(args)});
  const header=find(p.sidebar(),n=>n.props['data-action']==='new-task');
  header.props.onClick();
  assert.deepEqual(starts,[[]]);
  assert.ok(!text(p.sidebar()).includes('⌘'),'no keyboard shortcut hint in the sidebar header');
  p.close();
});

test('with the routing wrapper installed the click still reaches it without arguments',async()=>{
  const native=[];
  const p=await page({hosts:[host('mac','本机',[])],nativeStart:(...args)=>native.push(args)});
  const routed=p.ui.uiWorkspace.startSession;
  const seen=[];
  p.ui.uiWorkspace.startSession=(...args)=>{seen.push(args);return routed(...args);};
  find(p.sidebar(),n=>n.props['data-action']==='new-task').props.onClick();
  assert.deepEqual(seen,[[]],'the sidebar must not pin a workspace id onto the routed call');
  assert.equal(native.length,1);
  p.close();
});

test('the project row offers two 24x24 actions and "查看文件" is inert',async()=>{
  const p=await page({hosts:[host('mac','本机',sessions(2))]});
  const tree=p.sidebar();
  const actions=find(tree,n=>n.props['data-workspace-actions']===true);
  // Group 5 added the "更多" entry, so the row now carries three 24x24 buttons.
  // The assertion pins the actions that must exist instead of a raw count.
  const buttons=walk(actions).filter(n=>n.type==='button');
  assert.deepEqual(buttons.map(button=>button.props['data-action']),['workspace-more','view-files','new-session']);
  for(const button of buttons){assert.equal(button.props.style.width,24);assert.equal(button.props.style.height,24);}
  const newSession=find(actions,n=>n.props['data-action']==='new-session');
  assert.equal(newSession.props.title,'新建任务');
  assert.match(newSession.props['aria-label'],/新建并打开会话$/);
  const viewFiles=find(actions,n=>n.props['data-action']==='view-files');
  assert.equal(viewFiles.props.disabled,true);
  assert.equal(viewFiles.props.title,'即将支持');
  assert.match(viewFiles.props['aria-label'],/查看文件/);
  const before=p.requests.length;
  viewFiles.props.onClick?.();
  await settle();
  assert.equal(p.requests.length,before,'view-files must not dispatch anything');
  // The reveal rules are CSS-only so the buttons stay in the tab order.
  const cssText=walk(tree).filter(n=>n.type==='style'&&!n.props['data-sidebar-shell-style']).map(n=>n.children.join('')).join('');
  assert.match(cssText,/\[data-workspace-actions\]\{opacity:1;pointer-events:auto\}/);
  assert.ok(!cssText.includes('[data-flat-workspace-row]:hover'),'the whole row must not reveal the actions');
  assert.ok(!cssText.includes('[data-flat-workspace-row]:focus-within'),'session-row focus must not reveal the actions');
  // The header owns the actions; its subtree holds no session rows.
  const header=find(tree,n=>n.props['data-workspace-header']===true);
  assert.ok(walk(header).some(n=>n.props['data-workspace-actions']===true),'the header must contain the actions');
  assert.ok(!walk(header).some(n=>typeof n.props['data-row-key']==='string'&&n.props['data-row-key'].startsWith('session:')),'the header must not contain session rows');
  assert.ok(!/visibility\s*:\s*hidden|display\s*:\s*none/.test(cssText));
  p.close();
});

test('session rows show a relative timestamp without NaN when updatedAt is missing',async()=>{
  const items=sessions(5);
  delete items[2].updatedAt;
  const p=await page({hosts:[host('mac','本机',items)]});
  const tree=p.expand();
  const times=walk(tree).filter(n=>n.props['data-relative-time']===true);
  assert.equal(times.length,4,'the row without updatedAt renders no timestamp');
  for(const node of times)assert.ok(!text(node).includes('NaN'));
  assert.ok(!text(tree).includes('NaN'));
  const withoutTime=find(tree,n=>n.props['data-row-key']==='session:s3');
  assert.equal(walk(withoutTime).filter(n=>n.props['data-relative-time']===true).length,0);
  for(const row of sessionRows(tree)){
    assert.ok(!text(row).includes('NaN'));
    assert.equal(row.props.style.minHeight,34);
  }
  p.close();
});
