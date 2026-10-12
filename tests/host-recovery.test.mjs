import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { HostClient } from '../packages/client/dist/index.js';

async function until(condition, timeout=12000) {
  const end=Date.now()+timeout;
  while(!await condition()) { if(Date.now()>end) throw new Error('Fixture timed out'); await new Promise(resolve=>setTimeout(resolve,20)); }
}
test('real Host recovers the same session after Pi exits and retires unfinished work', {timeout:30000}, async t => {
  const directory=await mkdtemp(join(tmpdir(),'vagus-stage-one-'));
  const log=join(directory,'spawns.jsonl'); const script=fileURLToPath(new URL('./fixtures/fake-pi.mjs',import.meta.url));
  const command=join(directory,process.platform==='win32'?'fake-pi.cmd':'fake-pi');
  await writeFile(command, process.platform==='win32' ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`, {mode:0o755});
  const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  const token=randomBytes(32).toString('hex');
  const host=spawn(process.execPath,[resolve('packages/host/dist/server.js')],{env:{...process.env,VAGUS_HOST_TOKEN:token,VAGUS_HOST_PORT:String(port),VAGUS_DATA_DIR:join(directory,'data'),VAGUS_PI_COMMAND:command,VAGUS_TEST_DIRECTORY:directory,VAGUS_TEST_LOG:log,VAGUS_MANAGED_HOST:'1',VAGUS_MAX_IDLE_AGENTS:'1',VAGUS_IDLE_AGENT_SWEEP_MS:'50'},stdio:['pipe','pipe','pipe'],windowsHide:true});
  let output='',diagnostics='';host.stdout.on('data',chunk=>output+=chunk);host.stderr.on('data',chunk=>diagnostics+=chunk);
  const client=new HostClient(`ws://127.0.0.1:${port}/rpc`,{token});
  const observer=new HostClient(`ws://127.0.0.1:${port}/rpc`,{token});
  const observerEvents=[];observer.onEvent(event=>observerEvents.push(event));
  t.after(async()=>{client.close();observer.close();if(host.exitCode===null){host.stdin.end('shutdown\n');await Promise.race([once(host,'exit'),new Promise(resolve=>setTimeout(resolve,5000))]);if(host.exitCode===null){host.kill();await once(host,'exit');}}await rm(directory,{recursive:true,force:true});});
  await until(()=>{if(host.exitCode!==null)throw new Error('Host exited: '+diagnostics);return output.includes('VAGUS_HOST_READY');});
  await client.connect();
  await observer.connect();
  const catalog=await client.request('providers.models.refresh',{providerId:'pi'});assert.equal(catalog.error,undefined,diagnostics);
  const session=await client.request('sessions.create',{providerId:'pi',projectId:null});const events=[];client.onEvent(event=>events.push(event));
  await client.request('sessions.subscribe',{sessionId:session.id});
  await client.request('sessions.send',{sessionId:session.id,text:'crash fixture'});
  await until(()=>events.some(event=>event.type==='session.state'&&event.state==='ended'));
  let opened;
  try { opened=await client.request('sessions.open',{sessionId:session.id}); }
  catch(error) { throw new Error(`After the first Pi process exited: ${error instanceof Error ? error.message : String(error)}; hostExit=${host.exitCode}; clientConnected=${client.connected}; stdout=${output.slice(-1600)}; stderr=${diagnostics.slice(-1600)}`); }
  assert.equal(opened.state,'ended');assert.equal(opened.timeline.find(entry=>entry.kind==='tool').state,'error');
  assert.ok(opened.timeline.some(entry=>entry.kind==='interaction'&&entry.state==='cancelled'&&entry.reason==='interrupted'));
  await client.request('sessions.send',{sessionId:session.id,text:'recover fixture'});
  await until(()=>events.some(event=>event.type==='message.completed'&&events.some(start=>start.type==='message.started'&&start.role==='assistant'&&start.messageId===event.messageId)));
  opened=await client.request('sessions.open',{sessionId:session.id});
  assert.deepEqual(opened.messages.filter(message=>message.role==='user').map(message=>message.text),['crash fixture','recover fixture']);
  assert.equal(opened.messages.find(message=>message.role==='assistant').text,'Recovered response');
  assert.equal(observerEvents.some(event=>event.type==='message.delta'),false,'stream deltas are sent only to the client subscribed to this session');
  assert.equal(observerEvents.some(event=>event.type==='message.completed'),true,'low-frequency lifecycle events remain visible for workspace state');
  const historyPage=await client.request('sessions.history',{sessionId:session.id,limit:1});
  assert.equal(historyPage.entries.length,1);assert.equal(historyPage.byteLength,Buffer.byteLength(JSON.stringify(historyPage.entries)));assert.ok(historyPage.byteLength<=1024*1024);
  const canonicalEntry=await client.request('sessions.entry',{sessionId:session.id,entryId:historyPage.entries[0].id});
  assert.equal(canonicalEntry.id,historyPage.entries[0].id);assert.equal(canonicalEntry.contentDeferred,undefined);
  const sequences=events.filter(event=>typeof event.sequence==='number').map(event=>event.sequence);assert.deepEqual(sequences,[...new Set(sequences)].sort((a,b)=>a-b));
  const spawns=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(spawns.every(process=>!process.secretInherited));
  const sessions=spawns.filter(process=>!process.probe);assert.equal(sessions.length,2);assert.equal(sessions[1].resumed,true);assert.equal(sessions[0].sessionFile,sessions[1].sessionFile);
  await client.request('sessions.create',{providerId:'pi',projectId:null});
  await until(async()=>{const snapshot=await client.request('host.performance',{});return snapshot.requests['agent.runtime.suspended']?.count===1;});
  const endedBeforeSuspend=events.filter(event=>event.type==='session.state'&&event.state==='ended').length;
  await client.request('sessions.get-settings',{sessionId:session.id});
  const restarted=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line)).filter(process=>!process.probe);
  assert.equal(restarted.length,4,'the idle Agent can be resumed after its runtime is suspended');
  assert.equal(restarted[3].resumed,true);
  assert.equal(events.filter(event=>event.type==='session.state'&&event.state==='ended').length,endedBeforeSuspend,'suspension is not reported as ending the saved conversation');
  assert.equal(output.includes(token)||diagnostics.includes(token),false);
});
