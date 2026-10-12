import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';
import { broadcastRpcMessage, createRpcTransport } from '../packages/host/dist/transport/rpc-transport.js';
import { RPC_LIMITS } from '../packages/protocol/dist/index.js';

const waitFor=async condition=>{const end=Date.now()+3000;while(!condition()){if(Date.now()>end)throw new Error('Timed out');await new Promise(resolve=>setTimeout(resolve,10));}};

test('a slow client is isolated, healthy clients stay live, and reconnect can resnapshot state', async t => {
  const server=createServer(), token=randomBytes(32).toString('hex'), sockets=new Set();
  let snapshotRevision=1;
  const transport=createRpcTransport(server,{token,origins:new Set(['http://tauri.localhost'])},sockets,async(ws,req)=>{
    if(req.type==='workspace.snapshot') ws.send(JSON.stringify({id:req.id,ok:true,data:{revision:snapshotRevision}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`ws://127.0.0.1:${server.address().port}/rpc`;
  const slow=new HostClient(url,{token,autoReconnect:true,retryDelays:[10,20,40]});
  const healthy=new HostClient(url,{token,autoReconnect:true,retryDelays:[10,20,40]});
  t.after(async()=>{slow.close();healthy.close();transport.close();await new Promise(resolve=>server.close(resolve));});
  let slowConnectedCount=0, healthyEvents=0;
  slow.onConnection(connected=>{if(connected)slowConnectedCount++;});
  healthy.onEvent(()=>healthyEvents++);
  await slow.connect();await waitFor(()=>sockets.size===1);
  await healthy.connect();await waitFor(()=>sockets.size===2);
  const slowSocket=[...sockets][0];
  Object.defineProperty(slowSocket,'bufferedAmount',{configurable:true,get:()=>RPC_LIMITS.outboundBufferedBytes});
  snapshotRevision=2;
  broadcastRpcMessage(sockets,JSON.stringify({type:'event',event:{type:'workspace.changed'}}));
  await waitFor(()=>healthyEvents===1);
  assert.deepEqual(await healthy.request('workspace.snapshot'),{revision:2});
  await waitFor(()=>slowConnectedCount===2);
  assert.deepEqual(await slow.request('workspace.snapshot'),{revision:2});
  assert.equal(healthyEvents,1,'closing the slow peer does not interrupt the healthy peer');
});

test('authenticated Client reconnects without replaying unconfirmed mutations', async t => {
  const server=createServer(), token=randomBytes(32).toString('hex'), sockets=new Set();let mutations=0;
  const transport=createRpcTransport(server,{token,origins:new Set(['http://tauri.localhost'])},sockets,async(ws,req)=>{if(req.type==='host.shutdown'){mutations++;return;}ws.send(JSON.stringify({id:req.id,ok:true,data:'alive'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=new HostClient(`ws://127.0.0.1:${server.address().port}/rpc`,{token,autoReconnect:true,retryDelays:[10,20,40]});
  t.after(async()=>{client.close();transport.close();await new Promise(resolve=>server.close(resolve));});
  const states=[];client.onConnection(value=>states.push(value));
  await Promise.all([client.connect(),client.connect()]);assert.equal(sockets.size,1);
  const pending=client.request('host.shutdown');const rejected=assert.rejects(pending,/结果未确认/);
  await waitFor(()=>mutations===1);for(const socket of sockets)socket.terminate();await rejected;
  await waitFor(()=>states.filter(value=>value).length===2);assert.equal(mutations,1);
  assert.equal(await client.request('workspace.snapshot'),'alive');client.close();await new Promise(resolve=>setTimeout(resolve,80));assert.equal(sockets.size,0);
});

test('managed Host ready event can force reconnect with rotated credentials', async t => {
  const server=createServer(), sockets=new Set();
  const access={token:randomBytes(32).toString('hex'),origins:new Set(['http://tauri.localhost'])};
  const transport=createRpcTransport(server,access,sockets,async(ws,req)=>ws.send(JSON.stringify({id:req.id,ok:true,data:'alive'})));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`ws://127.0.0.1:${server.address().port}/rpc`;
  const client=new HostClient(url,{autoReconnect:true,retryDelays:[1000,2000],getConnection:async()=>({url,token:access.token})});
  const states=[];client.onConnection(value=>states.push(value));
  t.after(async()=>{client.close();transport.close();await new Promise(resolve=>server.close(resolve));});
  await client.connect();
  access.token=randomBytes(32).toString('hex');
  for (const socket of [...sockets]) socket.terminate();
  await waitFor(()=>states.includes(false));
  await client.reconnect();
  await waitFor(()=>states.filter(Boolean).length===2);
  assert.equal(await client.request('workspace.snapshot'),'alive');
});

test('wrong authentication fails before connected=true',async t=>{
  const server=createServer();const transport=createRpcTransport(server,{token:'a'.repeat(64),origins:new Set(['http://tauri.localhost'])},new Set(),async()=>{});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const client=new HostClient(`ws://127.0.0.1:${server.address().port}/rpc`,{token:'b'.repeat(64)});const states=[];client.onConnection(state=>states.push(state));
  t.after(async()=>{client.close();transport.close();await new Promise(resolve=>server.close(resolve));});
  await assert.rejects(client.connect(),/Authentication/);assert.equal(states.includes(true),false);
});

test('typed Client cancellation is local and reports an unconfirmed result', async t => {
  const server=createServer(),token=randomBytes(32).toString('hex'),sockets=new Set();let received=0;
  const transport=createRpcTransport(server,{token,origins:new Set(['http://tauri.localhost'])},sockets,async()=>{received++;});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const client=new HostClient(`ws://127.0.0.1:${server.address().port}/rpc`,{token});
  t.after(async()=>{client.close();transport.close();await new Promise(resolve=>server.close(resolve));});
  await client.connect();
  const beforeSend=new AbortController();beforeSend.abort();
  await assert.rejects(client.request('host.shutdown',undefined,{signal:beforeSend.signal}),/未发送/);
  assert.equal(received,0);
  const controller=new AbortController();
  const pending=client.request('host.shutdown',undefined,{timeoutMs:0,signal:controller.signal});
  await waitFor(()=>received===1);controller.abort();
  await assert.rejects(pending,/结果未确认/);
  assert.equal(received,1);
});

test('desktop bootstrap rotates credentials and offline clients retry until closed',async t=>{
  const server=createServer(),token='a'.repeat(64);const transport=createRpcTransport(server,{token,origins:new Set(['http://tauri.localhost'])},new Set(),async(ws,req)=>ws.send(JSON.stringify({id:req.id,ok:true,data:'alive'})));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let reads=0;const url=`ws://127.0.0.1:${server.address().port}/rpc`;
  const client=new HostClient(url,{autoReconnect:true,retryDelays:[10,20],getConnection:async()=>({url,token:++reads===1?'b'.repeat(64):token})});let connected=false;client.onConnection(value=>connected=value);
  t.after(async()=>{client.close();transport.close();await new Promise(resolve=>server.close(resolve));});
  await assert.rejects(client.connect());await waitFor(()=>connected);assert.equal(reads,2);assert.equal(await client.request('workspace.snapshot'),'alive');client.close();
  let failures=0;const unavailable=new HostClient(url,{autoReconnect:true,retryDelays:[10,20],getConnection:async()=>{failures++;throw new Error('Offline');}});t.after(()=>unavailable.close());await assert.rejects(unavailable.connect());await waitFor(()=>failures>=4);unavailable.close();const closedAt=failures;await new Promise(resolve=>setTimeout(resolve,50));assert.equal(failures,closedAt,'closing the client stops the retry loop');
});

test('desktop client reconnects when Host returns after the retry backoff is capped',async t=>{
  const server=createServer(),token=randomBytes(32).toString('hex'),sockets=new Set();
  const transport=createRpcTransport(server,{token,origins:new Set(['http://tauri.localhost'])},sockets,async(ws,req)=>ws.send(JSON.stringify({id:req.id,ok:true,data:'alive'})));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));
  const url=`ws://127.0.0.1:${port}/rpc`;let reads=0;const client=new HostClient(url,{autoReconnect:true,retryDelays:[5,10],getConnection:async()=>{reads++;return {url,token};}});let connected=false;client.onConnection(value=>connected=value);
  t.after(async()=>{client.close();transport.close();if(server.listening)await new Promise(resolve=>server.close(resolve));});
  await assert.rejects(client.connect());await waitFor(()=>reads>=8);
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));await waitFor(()=>connected);
  assert.equal(await client.request('workspace.snapshot'),'alive');
});
