import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createRpcTransport, hostAccess, sendRpcMessage } from '../packages/host/dist/transport/rpc-transport.js';
import { parseRpcRequest, RPC_LIMITS } from '../packages/protocol/dist/index.js';

test('all invalid envelope forms and unsafe fields are rejected', () => {
  for (const value of [null, [], 1, 'x', {}, {id:1,type:'workspace.snapshot'}, {id:'a',type:'unknown'}, {id:'a',type:'sessions.send',payload:null}, {id:'a',type:'sessions.send',payload:{sessionId:[],text:1}}, {id:'a',type:'host.performance',payload:{enabled:'true'}}, JSON.parse('{"id":"a","type":"workspace.snapshot","payload":{"__proto__":{}}}')]) assert.throws(() => parseRpcRequest(value));
  for (const [type, payload] of [['providers.mcp.manage',{providerId:'claude',serverName:'server',action:'remove'}]]) {
    assert.throws(() => parseRpcRequest({id:'retired',type,payload}), /Unknown command/);
  }
  assert.equal(parseRpcRequest({id:'a',type:'providers.plugins.install',payload:{providerId:'claude',pluginId:'reviewer@official',scope:'user'}}).type,'providers.plugins.install');
  assert.equal(parseRpcRequest({id:'a',type:'providers.plugins.marketplace',payload:{providerId:'claude',action:'add',source:'https://example.com/marketplace.git'}}).type,'providers.plugins.marketplace');
  assert.throws(() => parseRpcRequest({id:'a',type:'providers.plugins.install',payload:{providerId:'claude',pluginId:'bad id'}}));
  assert.throws(() => parseRpcRequest({id:'a',type:'providers.plugins.install',payload:{providerId:'claude',pluginId:'reviewer',acceptCommandSha256:'not-a-hash'}}));
  assert.equal(parseRpcRequest({id:'a',type:'sessions.create',payload:{projectId:null}}).type,'sessions.create');
  assert.equal(parseRpcRequest({id:'a',type:'sessions.cancel-subagent',payload:{sessionId:'parent',subagentSessionId:'child'}}).type,'sessions.cancel-subagent');
  for (const payload of [
    {sessionId:'parent'},
    {sessionId:'parent',subagentSessionId:''},
    {sessionId:'parent',subagentSessionId:'child',force:true},
  ]) assert.throws(() => parseRpcRequest({id:'a',type:'sessions.cancel-subagent',payload}));
  assert.doesNotThrow(() => parseRpcRequest({id:'a',type:'sessions.send',payload:{sessionId:'s',text:'hello',attachments:[{dataUrl:'data:image/png;base64,'+'A'.repeat(7*1024*1024)}]}}));
});
test('Host access has no implicit unauthenticated mode', () => {
  assert.throws(() => hostAccess({}));
  assert.throws(() => hostAccess({VAGUS_HOST_TOKEN:'password'}));
  assert.throws(() => hostAccess({VAGUS_HOST_TOKEN:'a'.repeat(64),VAGUS_ALLOWED_ORIGINS:'["*"]'}));
});
test('outbound backlog is bounded and retires only the slow socket', () => {
  const sent=[]; let closed;
  const slow={readyState:1,OPEN:1,bufferedAmount:RPC_LIMITS.outboundBufferedBytes,send:value=>sent.push(value),close:(code,reason)=>{closed={code,reason};},terminate(){}};
  assert.equal(sendRpcMessage(slow,'x'),false);
  assert.equal(sent.length,0);
  assert.equal(closed.code,1013);
  assert.match(closed.reason,/reconnect to resync/);

  const healthy={...slow,bufferedAmount:0,send:value=>sent.push(value),close(){throw new Error('healthy socket closed');}};
  assert.equal(sendRpcMessage(healthy,'ok'),true);
  assert.deepEqual(sent,['ok']);
});

async function fixture(t, handle) {
  const server = createServer(); const token = randomBytes(32).toString('hex'); const clients = new Set();
  const transport = createRpcTransport(server,{token,origins:new Set(['http://tauri.localhost'])},clients,handle ?? (async (socket, request) => socket.send(JSON.stringify({id:request.id,ok:true,data:'alive'}))));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(async () => { transport.close(); await new Promise(resolve => server.close(resolve)); });
  const url = `ws://127.0.0.1:${server.address().port}/rpc`;
  const connect = async () => { const ws = new WebSocket(url,{origin:'http://tauri.localhost'}); await once(ws,'open'); return ws; };
  return {token,url,clients,connect};
}
async function request(ws, value) { const response = once(ws,'message'); ws.send(typeof value === 'string' ? value : JSON.stringify(value)); return JSON.parse(String((await response)[0])); }
const auth = (token, version=1) => ({id:'auth',type:'host.authenticate',payload:{token,version}});

test('wrong Origin cannot upgrade even with a valid credential', async t => {
  const f = await fixture(t); const ws = new WebSocket(f.url,{origin:'https://audit.invalid'});
  const [error] = await once(ws,'error'); assert.match(error.message,/401/); assert.equal(f.clients.size,0);
});
test('unauthenticated clients receive no events and no RPC result', async t => {
  const f = await fixture(t); const ws = await f.connect(); assert.equal(f.clients.size,0);
  const closed = once(ws,'close'); assert.equal((await request(ws,{id:'x',type:'workspace.snapshot'})).code,'UNAUTHORIZED'); await closed;
});
test('wrong credential and incompatible protocol are rejected', async t => {
  const f = await fixture(t);
  for (const [token,version,code] of [['b'.repeat(64),1,'UNAUTHORIZED'],[f.token,42,'INCOMPATIBLE_PROTOCOL']]) {
    const ws = await f.connect(); const closed=once(ws,'close'); assert.equal((await request(ws,auth(token,version))).code,code); await closed;
  }
});
test('null, malformed JSON and handler failures cannot kill another connection', async t => {
  const f = await fixture(t, async (ws, req) => { if(req.type==='host.performance') throw new Error('private detail'); ws.send(JSON.stringify({id:req.id,ok:true,data:'alive'})); });
  const bad = await f.connect(), good = await f.connect();
  assert.equal((await request(bad,auth(f.token))).ok,true); await request(good,auth(f.token));
  assert.equal((await request(bad,'null')).code,'INVALID_REQUEST');
  assert.equal((await request(bad,'{')).code,'INVALID_REQUEST');
  assert.equal((await request(bad,{id:'e',type:'host.performance'})).code,'INTERNAL_ERROR');
  assert.equal((await request(good,{id:'ok',type:'workspace.snapshot'})).data,'alive');
});
test('oversized frame is isolated to its sender', async t => {
  const f = await fixture(t); const bad = await f.connect(), good = await f.connect(); await request(bad,auth(f.token)); await request(good,auth(f.token));
  const closed=once(bad,'close'); bad.send('x'.repeat(RPC_LIMITS.messageBytes+1)); await closed;
  assert.equal((await request(good,{id:'ok',type:'workspace.snapshot'})).ok,true);
});
test('in-flight requests and connection counts have hard budgets', async t => {
  let complete; const blocked = new Promise(resolve => { complete=resolve; });
  const f = await fixture(t, async () => blocked); const ws = await f.connect(); await request(ws,auth(f.token));
  for(let i=0;i<RPC_LIMITS.inFlight;i++) ws.send(JSON.stringify({id:'pending-'+i,type:'workspace.snapshot'}));
  assert.equal((await request(ws,{id:'overflow',type:'workspace.snapshot'})).code,'OVERLOADED'); complete();
  const sockets = [ws]; for(let i=1;i<RPC_LIMITS.connections;i++) sockets.push(await f.connect());
  const extra = new WebSocket(f.url); const [error]=await once(extra,'error'); assert.match(error.message,/401/);
});

test('eight invalid requests retire only the abusive authenticated connection', async t => {
  const f=await fixture(t), bad=await f.connect(), good=await f.connect();await request(bad,auth(f.token));await request(good,auth(f.token));
  const closed=once(bad,'close');for(let i=0;i<8;i++)assert.equal((await request(bad,'null')).code,'INVALID_REQUEST');await closed;
  assert.equal((await request(good,{id:'alive',type:'workspace.snapshot'})).ok,true);
});
test('binary input is rejected and authentication has a deadline', async t => {
  const f=await fixture(t), binary=await f.connect();const closed=once(binary,'close');const response=once(binary,'message');binary.send(Buffer.from('{}'));assert.equal(JSON.parse(String((await response)[0])).code,'INVALID_REQUEST');await closed;
  const idle=await f.connect();const [code]=await once(idle,'close');assert.equal(code,1008);assert.equal(f.clients.size,0);
});
