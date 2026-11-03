import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {MessageChannel} from 'node:worker_threads';
const helper=fs.readFileSync(new URL('../persistent-parent.template.js',import.meta.url),'utf8');
const routing=fs.readFileSync(new URL('../lib/transport.js',import.meta.url),'utf8').replaceAll('export ','');
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));};
test('one source startup and expired lease cannot replace or close another source frame',async()=>{
  let now=0;const actions=[],ports=[],intervals=[],bridges=new Map(),serial=new Map(),live=new Map(),maximum=new Map(),expire=new Set();
  const env={URL,Promise,Error,Map,MessageChannel,Date:{now:()=>now},setInterval:fn=>{intervals.push(fn);return intervals.length;},clearInterval(){},clearTimeout,setTimeout:(fn,ms)=>ms===300?setTimeout(()=>{now+=5000;fn();},0):setTimeout(fn,ms),window:{location:{origin:'dsh-app://app'}}};
  vm.createContext(env);vm.runInContext(routing+'\n'+helper+'\n;globalThis.make=createPersistentEmbed;',env);
  function make(id){
    const bridge=env.make({hostId:id,fetch:async(path,options)=>{
      const body=JSON.parse(options.body);actions.push({path,body});
      if(path.endsWith('/refresh')&&expire.has(id))return {ok:false,status:403,json:async()=>({ok:false})};
      let value={expiresAt:now+1200000};
      if(path.endsWith('/bootstrap')){
        const seq=(serial.get(id)||0)+1;serial.set(id,seq);const origin='http://127.0.0.1:'+(id==='alpha'?39891:39892);
        value={frameId:id+'-'+seq,frameOrigin:origin,frameUrl:origin+'/?bootstrap='+seq,controlToken:id+'-token-'+seq,expiresAt:now+1200000};
      }
      return {ok:true,json:async()=>({ok:true,value})};
    },changed:value=>{
      if(!Object.hasOwn(value,'metadata'))return;
      if(!value.metadata){live.set(id,0);bridges.get(id)?.attach(null);return;}
      live.set(id,(live.get(id)||0)+1);maximum.set(id,Math.max(maximum.get(id)||0,live.get(id)));
      const metadata=value.metadata;
      bridges.get(id).attach({focus(){},contentWindow:{postMessage(message,origin,transfer){
        assert.equal(origin,metadata.frameOrigin);assert.equal(message.controlToken,metadata.controlToken);const port=transfer[0];ports.push(port);
        if(id==='alpha'&&serial.get(id)===1)return;
        port.on('message',message=>port.postMessage({id:message.id,ok:true,value:{sessionId:message.sessionId,frameId:metadata.frameId}}));
        port.postMessage({type:'ready',frameId:metadata.frameId,sessionId:'shared-id'});
      }}});
    }});bridges.set(id,bridge);return bridge;
  }
  const alpha=make('alpha'),beta=make('beta');
  await beta.open('shared-id');const stableBeta=beta.status().metadata.frameId;
  await assert.rejects(alpha.open('shared-id'),/尚未就绪/);await settle();
  assert.equal(alpha.status().metadata,undefined);assert.equal(beta.status().metadata.frameId,stableBeta);assert.equal(beta.status().ready,true);
  assert.equal(actions.filter(a=>a.path==='/api/dsh-unified/hosts/beta/embed/close').length,0);
  await alpha.open('shared-id');assert.equal(serial.get('alpha'),2);await beta.open('shared-id');assert.equal(serial.get('beta'),1);
  expire.add('alpha');intervals[2]();await settle(); // alpha's second bootstrap lease callback
  await alpha.open('shared-id');assert.equal(serial.get('alpha'),3);assert.equal(beta.status().metadata.frameId,stableBeta);
  assert.equal(maximum.get('alpha'),1);assert.equal(maximum.get('beta'),1);
  assert.throws(()=>env.make({hostId:'../other',fetch(){},changed(){}}),/标识无效/);
  alpha.dispose();beta.dispose();ports.forEach(port=>port.close());
});
