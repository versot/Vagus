import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncScope } from '../packages/app/src/lib/async-scope.ts';

test('30 interrupted acquisitions release late native resources and listeners once', async () => {
  let alive=0, released=0;
  for(let i=0;i<30;i++) {
    const scope=new AsyncScope(); let finish;
    const pending=scope.acquire(()=>new Promise(resolve=>{finish=resolve;}),()=>{alive--;released++;});
    await scope.dispose(); alive++; finish('resource'); assert.equal(await pending,undefined); await scope.dispose();
  }
  assert.equal(alive,0);assert.equal(released,30);
});
test('visible resources survive until disposal, one failure does not block other cleanup', async () => {
  const scope=new AsyncScope();const released=[];
  assert.equal(await scope.acquire(async()=>1,value=>{released.push(value);}),1);
  scope.add(()=>{throw new Error('closed window');});scope.add(()=>{released.push(2);});
  assert.equal(scope.active,true);await scope.dispose();assert.deepEqual(released,[1,2]);assert.equal(scope.active,false);
});
test('an obsolete generation cannot release the replacement resource', async () => {
  const old=new AsyncScope(), current=new AsyncScope();const closed=[];let finish;
  const pending=old.acquire(()=>new Promise(resolve=>{finish=resolve;}),id=>{closed.push(id);});
  await old.dispose();await current.acquire(async()=>'new',id=>{closed.push(id);});finish('old');await pending;
  assert.deepEqual(closed,['old']);assert.equal(current.active,true);await current.dispose();assert.deepEqual(closed,['old','new']);
});
