import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../packages/host/dist/storage/workspace-store.js';

test('session search pages are bounded, stable and complete', {timeout:15000}, async t => {
  const directory=await mkdtemp(join(tmpdir(),'vagus-session-search-'));
  const store=new WorkspaceStore(directory);
  t.after(async()=>{await store.close();await rm(directory,{recursive:true,force:true});});
  const occurredAt='2026-10-08T00:00:00.000Z';
  const sessions=Array.from({length:65},(_,index)=>({id:`search-session-${String(index).padStart(3,'0')}`,projectId:null,title:`Needle chat ${index}`,createdAt:occurredAt,updatedAt:occurredAt,state:'ended',eventSequence:1}));
  const entries=sessions.map((session,index)=>({sessionId:session.id,entry:{kind:'message',id:`search-message-${index}`,sequence:1,occurredAt,role:'user',text:'The shared needle appears here.',complete:true}}));
  await store.save([],sessions,entries);
  const first=await store.search('needle',false,{limit:30,offset:0});
  const second=await store.search('needle',false,{limit:30,offset:first.nextOffset});
  const third=await store.search('needle',false,{limit:30,offset:second.nextOffset});
  assert.equal(first.ids.length,30);assert.equal(first.hasMore,true);assert.equal(first.nextOffset,30);
  assert.equal(second.ids.length,30);assert.equal(second.hasMore,true);assert.equal(second.nextOffset,60);
  assert.equal(third.ids.length,5);assert.equal(third.hasMore,false);assert.equal(third.nextOffset,65);
  const all=[...first.ids,...second.ids,...third.ids];
  assert.deepEqual(all,sessions.map(session=>session.id));
  assert.equal(new Set(all).size,65);
});
