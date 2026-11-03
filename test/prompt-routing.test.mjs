import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createProxy, upstreamPath} from '../lib/proxy.js';

const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve('http://127.0.0.1:'+server.address().port)));
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});

test('prompt endpoints retain source identity, request body, locale and paired authorization',async()=>{
  const servers=[],proxies=[],seen=[];
  try{
    const origins=new Map();
    for(const id of ['alpha','beta']){
      const server=http.createServer(async(req,res)=>{
        const chunks=[];for await(const chunk of req)chunks.push(chunk);
        const text=Buffer.concat(chunks).toString();
        seen.push({id,url:req.url,method:req.method,cookie:req.headers.cookie,locale:req.headers['x-dsh-locale'],body:text});
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({host:id,sessionId:text?JSON.parse(text).sessionId:null}));
      });servers.push(server);origins.set(id,await listen(server));
    }
    for(const id of ['alpha','beta'])proxies.push(createProxy({origin:origins.get(id),httpPrefix:'/api/dsh-unified/hosts/'+id+'/native',muxPath:'/dsh-unified/hosts/'+id+'/remote.mux',authorize:async req=>req.headers.authorization==='Bearer fixture-device',credential:async()=> 'fixture-cookie-'+id,ready:async()=>true}));
    const parent=http.createServer((req,res)=>{
      const i=req.url.includes('/hosts/alpha/')?0:req.url.includes('/hosts/beta/')?1:-1;
      if(i<0)return res.writeHead(404).end();return proxies[i].httpHandler(req,res);
    });servers.push(parent);const origin=await listen(parent);
    for(const id of ['alpha','beta']){
      const path='/api/dsh-unified/hosts/'+id+'/native/_host/dsh-prompt-predict/suggest';
      const body=JSON.stringify({sessionId:'same-session-id'});
      const response=await fetch(origin+path+'?device=private-fixture&keep=1',{method:'POST',headers:{authorization:'Bearer fixture-device','content-type':'application/json','x-dsh-locale':'zh',cookie:'incoming-cookie-must-not-forward'},body});
      assert.equal(response.status,200);assert.deepEqual(await response.json(),{host:id,sessionId:'same-session-id'});
      const request=seen.at(-1);assert.equal(request.id,id);assert.equal(request.cookie,'fixture-cookie-'+id);assert.equal(request.locale,'zh');assert.equal(request.body,body);assert.equal(request.url,'/dsh-prompt-predict/suggest?keep=1');
      assert.equal((await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},body})).status,403);
    }
    assert.equal(seen.length,2,'unpaired calls must never reach either model helper');
    assert.equal(upstreamPath('/api/dsh-unified/hosts/alpha/native/_host/arbitrary-plugin/suggest','/api/dsh-unified/hosts/alpha/native'),undefined);
    assert.equal(upstreamPath('/api/dsh-unified/hosts/alpha/native/_host/dsh-prompt-predict-other/suggest','/api/dsh-unified/hosts/alpha/native'),undefined);
  }finally{proxies.forEach(p=>p.close());for(const server of servers.reverse())await close(server);}
});
