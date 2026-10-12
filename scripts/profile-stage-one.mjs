// Synthetic baseline: never opens or copies the user's workspace database.
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkspaceStore } from '../packages/host/dist/storage/workspace-store.js';
import { readHistoryPage } from '../packages/host/dist/storage/session-history.js';

const directory=await mkdtemp(join(tmpdir(),'vagus-stage-one-baseline-'));
const store=new WorkspaceStore(directory);const started=performance.now();
const metadata=Array.from({length:1000},(_,index)=>({id:`session-${index}`,projectId:null,title:`Audit needle-${index}`,createdAt:'2026-10-07T00:00:00.000Z',updatedAt:'2026-10-07T00:00:00.000Z',state:'ended',eventSequence:100}));
const entriesFor=session=>Array.from({length:100},(_,index)=>({kind:'message',id:`message-${session.id}-${index}`,role:index%2?'assistant':'user',text:`Vagus 合成历史 needle-${session.id.slice(8)} ${index}`,complete:true,sequence:index+1,turnId:`turn-${Math.floor(index/2)}`,occurredAt:session.createdAt}));
const p95=values=>[...values].sort((a,b)=>a-b)[Math.floor((values.length-1)*.95)];
try {
  await store.load();const initializeMs=performance.now()-started; const populateAt=performance.now();
  await store.save([],metadata,metadata.flatMap(session=>entriesFor(session).map(entry=>({sessionId:session.id,entry}))));
  const populationMs=performance.now()-populateAt;const pages=[],saves=[];let pageDifferences=0;
  for(let sample=0;sample<50;sample++){const session=metadata[(sample*37)%1000];const at=performance.now();const page=await store.history(session.id,{limit:40});pages.push(performance.now()-at);if(JSON.stringify(page)!==JSON.stringify(readHistoryPage(entriesFor(session),100,{limit:40})))pageDifferences++;}
  for(let sample=0;sample<20;sample++){const session=metadata[sample];const at=performance.now();await store.save([],metadata,[{sessionId:session.id,entry:{...entriesFor(session)[99],text:'Incremental profiling marker'}}]);saves.push(performance.now()-at);}
  const queries=[];for(const query of ['needle-777','V','Audit']){const at=performance.now();const results=await store.search(query,false,{limit:100,offset:0});queries.push({query,ms:performance.now()-at,matchesOnPage:results.ids.length,hasMore:results.hasMore});}
  const assets=resolve('packages/app/dist/assets');const appBundles={};
  for(const file of await readdir(assets))if(/^(main|appearance)-.*\.(js|css)$/.test(file))appBundles[file]=(await readFile(join(assets,file))).length;
  const metrics={measuredAt:new Date().toISOString(),sourceHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),sourceState:'working tree; phase one and concurrent file-viewer edits',node:process.version,os:release(),cpu:cpus()[0].model,totalMemoryBytes:totalmem(),dataset:'synthetic, isolated temporary directory',sessions:1000,entries:100000,initializeMs,populationMs,pageSize:40,pageSamples:50,pageP95Ms:p95(pages),pageMaxMs:Math.max(...pages),incrementalSaveSamples:20,incrementalSaveP95Ms:p95(saves),pageDifferences,queries,appBundles,profilerMemory:process.memoryUsage()};
  if(process.argv[2])await writeFile(resolve(process.argv[2]),JSON.stringify(metrics,null,2)+'\n'); console.log(JSON.stringify(metrics,null,2));
  if(pageDifferences)throw new Error('Synthetic history differs from canonical paging');
}finally{await store.close();await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
