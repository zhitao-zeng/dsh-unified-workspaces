import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
// Sidebar parity pass (group 3): a "任务列表" row with search and a view
// switch, a "项目" row that collapses everything or opens the per-machine
// creation form, and a "任务" section for sessions outside every project.
const read = name => fs.readFileSync(new URL('../'+name,import.meta.url),'utf8');
const helpers=read('lib/transport.js').replaceAll('export ','');
const source=read('client-main.template.js').replace('/* ROUTING_HELPERS */',helpers).replace('/* PERSISTENT_HELPERS */',read('persistent-parent.template.js')).replace('/* PLUGIN_SYNC */','function createPluginSyncPanel(){return()=>null;}').replace('          const rowStyle =','          globalThis.fixtureMatchesQuery = typeof matchesQuery === "function" ? matchesQuery : undefined;\n          const rowStyle =');
const walk=node=>Array.isArray(node)?node.flatMap(walk):!node||typeof node!=='object'?[]:[node,...(node.children||[]).flatMap(walk)];
const text=node=>walk(node).flatMap(n=>n.children).filter(child=>typeof child==='string'||typeof child==='number').join('');
const find=(tree,predicate)=>{const found=walk(tree).find(predicate);assert(found,'expected UI element');return found;};
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r));};
const sessionRows=tree=>walk(tree).filter(n=>typeof n.props['data-row-key']==='string'&&n.props['data-row-key'].startsWith('session:'));
const rowKeys=tree=>sessionRows(tree).map(n=>n.props['data-row-key']);
const flatHostIds=tree=>walk(tree).filter(n=>n.props['data-flat-workspace-row']).map(n=>n.props['data-host-id']);
const machineOf=row=>{const node=walk(row).find(n=>n.props['data-row-machine']===true);return node?text(node):undefined;};

const ws=(workspaceId,title,sessionIds)=>({workspaceId,path:'/projects/'+workspaceId,title,sessionIds});
const item=(sessionId,title,updatedAt,extra={})=>({sessionId,title,blank:false,updatedAt,...extra});
const mkHost=(id,label,status,workspaces,items)=>({id,label,status,workspaces,items,archivedSessionIds:[]});

async function page({hosts,selection={sessionId:'none'},initialStorage={}}={}){
  const registrations=[],effects=[],requests=[],calls=[],panels=[];
  const storage=new Map(Object.entries(initialStorage));
  const react={createElement:(type,props,...children)=>typeof type==='function'?type({...props,children}):{type,props:props||{},children:children.flat().filter(Boolean)},useSyncExternalStore:(_s,get)=>get(),useState:value=>[value,()=>{}],useEffect:()=>{}};
  const fetch=async (path,options={})=>{
    requests.push({path,body:options.body});
    if(path==='/api/dsh-unified/catalog')return {ok:true,json:async()=>({ok:true,hosts})};
    throw Error('unexpected fixture request '+path);
  };
  const service={selection:{getSnapshot:()=>selection,subscribe:()=>()=>{}},sessions:{refresh:async()=>{},list:{getSnapshot:()=>({phase:'ready',byId:{}})}},openSession:async()=>{},startSession:(...args)=>{calls.push(args);}};
  const ui={slots:{inject:(_n,fn)=>fn(),register:(options,component)=>{registrations.push({options,component});return()=>{};}},effect:fn=>effects.push(fn),layout:{toggleSidebar(){},selectPanel:value=>panels.push(value),panelInfo:{getSnapshot:()=>({activePanelId:null}),subscribe:()=>()=>{}}},uiWorkspace:service,locale:{getSnapshot:()=>({active:'zh-CN'})}};
  const env={console,URL,Promise,MessageChannel,AbortController,Set,Map,Error,JSON,Uint8Array,Date,crypto:{randomUUID:()=>'req-abcdefghijklmnop'},setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,String(value)),removeItem:key=>storage.delete(key)},document:{visibilityState:'visible',documentElement:{},addEventListener(){},removeEventListener(){},querySelector:()=>null}};
  env.__DSH_UNIFIED_PERSISTENT_LOCAL__=true;
  let plugin;env.window={fetch,innerWidth:1400,location:{origin:'dsh-app://app',reload(){throw Error('no reload expected');}},__ModuleLoader__:{load:value=>{plugin=value.factory(()=>react);}}};
  vm.runInNewContext(source,env);plugin.apply({inject:(_deps,fn)=>fn(ui)});const cleanups=effects.map(fn=>fn());await settle();
  const sidebar=()=>registrations.find(r=>r.options.name==='sidebar.workspaces').component({wide:true});
  const manager=()=>registrations.find(r=>r.options.name==='main').component();
  const expandAll=()=>{for(const node of walk(sidebar()).filter(n=>n.props['data-action']==='open-workspace'))node.props.onClick();return sidebar();};
  const click=action=>find(sidebar(),n=>n.props['data-action']===action).props.onClick();
  const search=value=>{find(sidebar(),n=>n.props['data-search-input']===true).props.onChange({target:{value}});return sidebar();};
  return {env,ui,service,requests,calls,panels,storage,sidebar,manager,expandAll,click,search,close:()=>cleanups.forEach(fn=>fn?.())};
}

test('matchesQuery ignores an empty query and requires every word in any order',async()=>{
  const p=await page({hosts:[mkHost('mac','本机','ready',[],[item('s1','Alpha 任务 1',Date.now())])]});
  const matchesQuery=p.env.fixtureMatchesQuery;
  assert.equal(typeof matchesQuery,'function');
  assert.equal(matchesQuery('Alpha 任务 1',''),true);
  assert.equal(matchesQuery('Alpha 任务 1','   '),true);
  assert.equal(matchesQuery('Alpha 任务 1','alpha'),true,'case-insensitive');
  assert.equal(matchesQuery('Alpha 任务 1','ALPHA'),true);
  assert.equal(matchesQuery('Alpha 任务 1','任务 alpha'),true,'word order does not matter');
  assert.equal(matchesQuery('Alpha 任务 1','  alpha   1  '),true,'trimmed and split on whitespace');
  assert.equal(matchesQuery('Alpha 任务 1','alpha 2'),false);
  assert.equal(matchesQuery('Alpha 任务 1','alpha beta'),false);
  assert.equal(matchesQuery('Alpha 任务 1','beta'),false);
  assert.equal(matchesQuery('','alpha'),false);
  p.close();
});

test('search keeps only matching sessions, forces them all, and reports an empty result',async()=>{
  const now=Date.now();
  const macItems=[item('m1','mac 任务 1',now-60_000)];
  const alphaItems=Array.from({length:8},(_,index)=>item('a'+(index+1),'alpha 任务 '+(index+1),now-(index+2)*60_000));
  const hosts=[
    mkHost('mac','本机','ready',[ws('wmac','本地项目',macItems.map(row=>row.sessionId))],macItems),
    mkHost('alpha','Alpha · 测试','ready',[ws('walpha','alpha 项目',alphaItems.map(row=>row.sessionId))],alphaItems),
  ];
  const p=await page({hosts});
  const expanded=p.expandAll();
  assert.equal(rowKeys(expanded).length,6,'baseline: mac 1 + alpha 5');
  assert.deepEqual(flatHostIds(expanded),['mac','alpha']);

  p.click('search');
  const opened=p.sidebar();
  const input=find(opened,n=>n.props['data-search-input']===true);
  assert.equal(input.props['aria-label'],'搜索任务');
  assert.equal(input.props.placeholder,'搜索任务');
  assert.equal(input.props.value,'');

  const matched=p.search('alpha');
  assert.deepEqual(flatHostIds(matched),['alpha'],'a project without a hit is not rendered at all');
  assert.equal(rowKeys(matched).length,8,'every matching row shows regardless of the five-row limit');
  assert.ok(rowKeys(matched).every(key=>key.startsWith('session:a')));
  assert.equal(walk(matched).filter(n=>n.props['data-action']==='show-more').length,0);

  const missing=p.search('zzz');
  assert.equal(rowKeys(missing).length,0);
  assert.deepEqual(flatHostIds(missing),[]);
  const empty=find(missing,n=>n.props['data-search-empty']===true);
  assert.equal(text(empty),'没有匹配的任务');

  p.click('search-clear');
  const cleared=p.sidebar();
  assert.equal(walk(cleared).filter(n=>n.props['data-search-input']===true).length,0);
  assert.equal(walk(cleared).filter(n=>n.props['data-search-empty']===true).length,0);
  assert.deepEqual(flatHostIds(cleared),['mac','alpha']);
  assert.equal(rowKeys(cleared).length,6,'clearing restores the default five-row view');

  p.click('search');
  p.search('alpha');
  p.click('search');
  const toggled=p.sidebar();
  assert.equal(walk(toggled).filter(n=>n.props['data-search-input']===true).length,0);
  assert.deepEqual(rowKeys(toggled),rowKeys(cleared),'toggling the search button off clears the query');
  p.close();
});

test('the recent view mixes machines by updatedAt, annotates the machine and persists',async()=>{
  const base=Date.now()-3_600_000;
  const macItems=Array.from({length:12},(_,index)=>item('m'+index,'Mac 任务 '+index,base-index*2*60_000));
  const alphaItems=Array.from({length:12},(_,index)=>item('a'+index,'Alpha 任务 '+index,base-(index*2+1)*60_000));
  const hosts=[
    mkHost('mac','本机','ready',[ws('wmac','本地项目',macItems.map(row=>row.sessionId))],macItems),
    mkHost('alpha','Alpha · 测试','ready',[ws('walpha','alpha 项目',alphaItems.map(row=>row.sessionId))],alphaItems),
  ];
  const p=await page({hosts});
  p.click('view-menu');
  const menu=p.sidebar();
  assert.equal(find(menu,n=>n.props['data-action']==='view-option'&&n.props['data-view']==='project').props['aria-pressed'],true);
  assert.equal(find(menu,n=>n.props['data-action']==='view-option'&&n.props['data-view']==='recent').props['aria-pressed'],false);
  find(menu,n=>n.props['data-action']==='view-option'&&n.props['data-view']==='recent').props.onClick();

  const recent=p.sidebar();
  assert.equal(walk(recent).filter(n=>n.props['data-flat-workspace-row']).length,0);
  assert.equal(walk(recent).filter(n=>n.props['data-loose-sessions']).length,0);
  assert.equal(walk(recent).filter(n=>n.props['data-action']==='new-project').length,0);
  assert.equal(find(recent,n=>n.props['data-recent-list']===true).props.role,'tree');
  assert.equal(p.storage.get('dsh-unified-sidebar-view'),'recent');
  const expectedFirst20=[];
  for(let index=0;index<10;index++)expectedFirst20.push('session:m'+index,'session:a'+index);
  assert.deepEqual(rowKeys(recent),expectedFirst20,'the newest twenty rows from both machines are interleaved');
  for(const row of sessionRows(recent))assert.ok(machineOf(row),'every recent row names its machine');
  assert.equal(machineOf(find(recent,n=>n.props['data-row-key']==='session:m0')),' · 本机');
  assert.equal(machineOf(find(recent,n=>n.props['data-row-key']==='session:a0')),' · Alpha');

  const more=find(recent,n=>n.props['data-action']==='show-more');
  assert.equal(more.props['data-view'],'recent');
  assert.equal(text(more),'显示更多');
  assert.equal(more.props['aria-label'],'显示更多，还有 4 条');
  more.props.onClick();
  const all=p.sidebar();
  assert.equal(rowKeys(all).length,24);
  assert.equal(walk(all).filter(n=>n.props['data-action']==='show-more').length,0);

  p.click('view-menu');
  find(p.sidebar(),n=>n.props['data-action']==='view-option'&&n.props['data-view']==='project').props.onClick();
  const back=p.sidebar();
  assert.deepEqual(flatHostIds(back),['mac','alpha']);
  assert.equal(walk(back).filter(n=>n.props['data-recent-list']).length,0);
  assert.equal(p.storage.get('dsh-unified-sidebar-view'),'project');
  p.close();
});

test('the saved view is restored on start and illegal values fall back to the project view',async()=>{
  const hosts=[mkHost('mac','本机','ready',[ws('wmac','本地项目',['s1'])],[item('s1','任务一',Date.now())])];
  const restored=await page({hosts,initialStorage:{'dsh-unified-sidebar-view':'recent'}});
  const tree=restored.sidebar();
  assert.equal(walk(tree).filter(n=>n.props['data-recent-list']).length,1);
  assert.equal(walk(tree).filter(n=>n.props['data-flat-workspace-row']).length,0);
  restored.close();

  const broken=await page({hosts,initialStorage:{'dsh-unified-sidebar-view':'bogus'}});
  const fallback=broken.sidebar();
  assert.equal(walk(fallback).filter(n=>n.props['data-recent-list']).length,0);
  assert.deepEqual(flatHostIds(fallback),['mac']);
  broken.click('view-menu');
  assert.equal(find(broken.sidebar(),n=>n.props['data-action']==='view-option'&&n.props['data-view']==='project').props['aria-pressed'],true);
  broken.close();
});

test('collapse-all folds every expanded project on every machine',async()=>{
  const now=Date.now();
  const hosts=[
    mkHost('mac','本机','ready',[ws('wmac','本地项目',['m1'])],[item('m1','mac 任务',now)]),
    mkHost('alpha','Alpha','ready',[ws('walpha','alpha 项目',['a1'])],[item('a1','alpha 任务',now-60_000)]),
  ];
  const p=await page({hosts});
  p.expandAll();
  const expanded=p.sidebar();
  const toggles=()=>walk(p.sidebar()).filter(n=>n.props['data-action']==='toggle-workspace');
  assert.ok(toggles().every(node=>node.props['aria-expanded']===true));
  assert.equal(rowKeys(expanded).length,2);

  p.click('collapse-all');
  assert.ok(toggles().every(node=>node.props['aria-expanded']===false),'every project is collapsed');
  assert.equal(rowKeys(p.sidebar()).length,0);
  p.close();
});

test('the new project row only offers ready machines and opens the creation form without dispatching',async()=>{
  const now=Date.now();
  const hosts=[
    mkHost('mac','本机','ready',[ws('wmac','本地项目',['m1'])],[item('m1','mac 任务',now)]),
    mkHost('alpha','Alpha · 测试','offline',[],[]),
    mkHost('gamma','Gamma','ready',[],[],),
  ];
  const p=await page({hosts});
  const before=p.requests.length;
  assert.ok(!text(p.sidebar()).includes('+ 本机工作区'),'the old bordered add row is gone');

  p.click('new-project');
  const menu=find(p.sidebar(),n=>n.props['data-new-project-menu']===true);
  const buttons=walk(menu).filter(n=>n.props['data-action']==='new-workspace');
  assert.deepEqual(buttons.map(node=>node.props['data-host-id']),['mac','gamma'],'offline machines are never listed');
  assert.match(text(buttons[0]),/在 本机 新建项目$/);
  assert.match(text(buttons[1]),/在 Gamma 新建项目$/);

  buttons[0].props.onClick();
  await settle();
  assert.equal(walk(p.sidebar()).filter(n=>n.props['data-new-project-menu']).length,0,'choosing a machine closes the menu');
  assert.ok(p.panels.includes('dsh-unified-host'),'the workbench opens');
  assert.ok(walk(p.manager()).some(n=>n.props['aria-label']==='新建工作区表单'),'the workspace form is mounted');
  assert.equal(p.requests.filter(request=>request.path.includes('/api/dsh-unified/manage/')).length,0,'opening the form dispatches nothing');
  assert.equal(p.requests.length,before,'still only the initial catalog read');

  const empty=find(p.sidebar(),n=>n.props['data-empty-remote-action']===true&&n.props['data-host-id']==='gamma');
  assert.match(text(empty),/\+ 添加 Gamma 工作区/);
  p.close();
});

test('the tasks section lists sessions outside every project with their machine',async()=>{
  const now=Date.now();
  const macItems=[item('m1','项目内任务',now-60_000),item('loose1','散落一',now-30_000),item('loose2','散落二',now-20_000)];
  const alphaItems=[item('a1','alpha 项目',now-90_000),item('alo1','alpha 散落',now-10_000)];
  const hosts=[
    mkHost('mac','本机','ready',[ws('wmac','本地项目',['m1'])],macItems),
    mkHost('alpha','Alpha','ready',[ws('walpha','alpha 项目',['a1'])],alphaItems),
  ];
  const p=await page({hosts});
  const tree=p.sidebar();
  const loose=find(tree,n=>n.props['data-loose-sessions']===true);
  assert.equal(loose.props.role,'group');
  assert.equal(loose.props['aria-label'],'任务');
  const looseKeys=rowKeys(loose);
  assert.deepEqual(looseKeys,['session:alo1','session:loose2','session:loose1'],'merged and sorted newest first');
  const looseRow=find(loose,n=>n.props['data-row-key']==='session:loose1');
  assert.equal(looseRow.props['data-workspace-id'],'__other__');
  assert.equal(machineOf(looseRow),' · 本机');
  assert.equal(machineOf(find(loose,n=>n.props['data-row-key']==='session:alo1')),' · Alpha');
  assert.equal(walk(loose).filter(n=>n.props['data-action']==='new-workspace'||n.props['data-action']==='new-session').length,0,'no create buttons in this section');

  const clean=await page({hosts:[mkHost('mac','本机','ready',[ws('wmac','本地项目',['m1'])],[item('m1','项目内任务',now)])]});
  assert.equal(walk(clean.sidebar()).filter(n=>n.props['data-loose-sessions']).length,0,'the section disappears when nothing is loose');
  clean.close();

  const manyItems=Array.from({length:7},(_,index)=>item('loose'+(index+1),'散落 '+(index+1),now-index*60_000));
  const many=await page({hosts:[mkHost('mac','本机','ready',[ws('wmac','本地项目',['m1'])],[item('m1','项目内任务',now-3_600_000),...manyItems])]});
  const manyLoose=find(many.sidebar(),n=>n.props['data-loose-sessions']===true);
  assert.equal(rowKeys(manyLoose).length,5,'default five loose rows');
  const more=find(manyLoose,n=>n.props['data-action']==='show-more');
  assert.equal(more.props['data-view'],'loose');
  assert.equal(text(more),'显示更多');
  assert.equal(more.props['aria-label'],'显示更多，还有 2 条');
  more.props.onClick();
  assert.equal(rowKeys(find(many.sidebar(),n=>n.props['data-loose-sessions']===true)).length,7);
  many.close();
  p.close();
});

test('session rows without the machine option keep the group-2 markup',async()=>{
  const now=Date.now();
  const p=await page({hosts:[mkHost('mac','本机','ready',[ws('wmac','本地项目',['s1','s2'])],[item('s1','一',now),item('s2','二',now-60_000)])]});
  const tree=p.expandAll();
  const rows=sessionRows(tree);
  assert.equal(rows.length,2);
  for(const row of rows)assert.equal(walk(row).filter(n=>n.props['data-row-machine']).length,0,'no machine suffix in the project view');
  assert.equal(rowKeys(tree).length,2);
  p.close();
});
