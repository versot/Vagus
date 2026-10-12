import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedHistoryEntry, readHistoryPage } from '../packages/host/dist/storage/session-history.js';
import { SESSION_HISTORY_PAGE_BYTE_BUDGET } from '../packages/protocol/dist/index.js';

function message(sequence, text, turnId='long-turn') {
  return {kind:'message',id:`m-${sequence}`,sequence,turnId,occurredAt:'2026-01-01T00:00:00.000Z',role:'assistant',text,complete:true};
}

test('history pages obey byte budgets while preserving every cursor, including deferred oversized entries', () => {
  const entries = Array.from({length:28},(_,index)=>message(index+1,'x'.repeat(52_000)));
  const collected=[];
  let beforeSequence;
  let page=readHistoryPage(entries,entries.length,{limit:120});
  while(true) {
    assert.ok(page.byteLength<=SESSION_HISTORY_PAGE_BYTE_BUDGET);
    assert.equal(page.byteLength,Buffer.byteLength(JSON.stringify(page.entries)));
    collected.unshift(...page.entries);
    if(!page.hasMore) break;
    beforeSequence=page.beforeSequence;
    page=readHistoryPage(entries,entries.length,{limit:120,beforeSequence});
  }
  assert.deepEqual(collected.map(entry=>entry.sequence),entries.map(entry=>entry.sequence));
  assert.ok(collected.every(entry=>entry.turnId==='long-turn'), 'a long turn can span pages');

  const withOversized=[message(1,'small'),{...message(2,'x'.repeat(SESSION_HISTORY_PAGE_BYTE_BUDGET+100)),attachments:[{id:'image-1',name:'large.png',mimeType:'image/png',size:2_000_000,dataUrl:`data:image/png;base64,${'A'.repeat(120_000)}`}],browserElements:[{id:'element',url:'https://example.com',selector:'p',tag:'p',text:'hello',html:'<p>hello</p>'}]},message(3,'small')];
  const newest=readHistoryPage(withOversized,3,{limit:1});
  assert.deepEqual(newest.entries.map(entry=>entry.sequence),[3]);
  const older=readHistoryPage(withOversized,3,{limit:1,beforeSequence:newest.beforeSequence});
  assert.deepEqual(older.entries.map(entry=>entry.sequence),[2]);
  assert.ok(older.byteLength<=SESSION_HISTORY_PAGE_BYTE_BUDGET);
  assert.equal(older.entries[0].contentDeferred,true);
  assert.equal(older.entries[0].text.length,2_000);
  assert.equal(older.entries[0].attachments[0].dataUrl,'');
  assert.equal(older.entries[0].browserElements,undefined);
  assert.ok(withOversized[1].text.length>SESSION_HISTORY_PAGE_BYTE_BUDGET, 'the stored source entry remains complete');
  assert.equal(boundedHistoryEntry(withOversized[1]).contentDeferred,true);
  const oldest=readHistoryPage(withOversized,3,{limit:1,beforeSequence:older.beforeSequence});
  assert.deepEqual(oldest.entries.map(entry=>entry.sequence),[1]);
});

test('a 10,000-entry single turn stays within the page budgets without gaps or duplicates', () => {
  const entries = Array.from({length:10_000},(_,index)=>message(index+1,'x'.repeat(256)));
  const collected=[];
  let beforeSequence;
  let pageCount=0;
  while (true) {
    const page=readHistoryPage(entries,entries.length,{limit:500,beforeSequence});
    pageCount++;
    assert.ok(page.entries.length<=500);
    assert.ok(page.byteLength<=SESSION_HISTORY_PAGE_BYTE_BUDGET);
    assert.equal(page.byteLength,Buffer.byteLength(JSON.stringify(page.entries)));
    assert.ok(page.entries.length>0, 'each cursor must make progress');
    collected.unshift(...page.entries);
    if (!page.hasMore) break;
    assert.notEqual(page.beforeSequence,beforeSequence, 'the cursor must advance');
    beforeSequence=page.beforeSequence;
  }
  assert.equal(pageCount,20, 'the count budget should cap each page at 500 records');
  assert.deepEqual(collected.map(entry=>entry.sequence),entries.map(entry=>entry.sequence));
  assert.ok(collected.every(entry=>entry.turnId==='long-turn'));
});
