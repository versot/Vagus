import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createReservation } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, delimiter, dirname } from 'node:path';
import { once } from 'node:events';

if (process.platform !== 'win32') throw new Error('Native regression requires Windows and WebView2');
const directory = await mkdtemp(join(tmpdir(), 'vagus-native-stage-one-'));
const script = resolve('tests/fixtures/fake-pi.mjs'), command = join(directory, 'fake-pi.cmd');
await writeFile(command, `@"${process.execPath}" "${script}" %*\r\n`);
const terminalScript = resolve('tests/fixtures/native-terminal-output.mjs');
const browserHoldMs = Math.max(0, Math.min(120_000, Number(process.env.VAGUS_SMOKE_BROWSER_HOLD_MS) || 0));
const page = createServer((_, response) => { response.writeHead(200, {'Content-Type':'text/html'}); response.end('<html><title>Local fixture</title><p>Native WebView regression</p></html>'); });
await new Promise(resolve => page.listen(0, '127.0.0.1', resolve));
const reservation=createReservation(); await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve)); const port=reservation.address().port; await new Promise(resolve=>reservation.close(resolve));
const build = spawn('cargo', ['build','--locked','--features','stage-one-smoke','--example','stage_one_smoke'], {cwd:resolve('packages/desktop/src-tauri'),stdio:'inherit',windowsHide:true});
if ((await once(build,'exit'))[0] !== 0) { await new Promise(resolve=>page.close(resolve)); throw new Error('Native regression build failed'); }
const executable=resolve('packages/desktop/src-tauri/target/debug/examples/stage_one_smoke.exe');
const child=spawn(executable, [], {env:{...process.env,PATH:join(process.env.SystemRoot,'System32')+delimiter+process.env.SystemRoot,VAGUS_NODE_PATH:process.execPath,VAGUS_SMOKE_DIRECTORY:directory,VAGUS_SMOKE_PORT:String(port),VAGUS_SMOKE_PAGE:`http://127.0.0.1:${page.address().port}/`,VAGUS_SMOKE_HOST:resolve('packages/host/dist/server.js'),VAGUS_SMOKE_TERMINAL_SCRIPT:terminalScript,VAGUS_PI_COMMAND:command,VAGUS_TEST_DIRECTORY:directory,VAGUS_TEST_LOG:join(directory,'spawns.jsonl'),...(browserHoldMs ? {VAGUS_SMOKE_BROWSER_HOLD_MS:String(browserHoldMs)} : {})},stdio:'inherit',windowsHide:true});
const timer=setTimeout(()=>child.kill(),180000);
const profileSamples = [];
const profileTask = browserHoldMs ? sampleBrowserResources(child, profileSamples) : Promise.resolve();
try {
  const [code]=await once(child,'exit'); await profileTask;
  const report=JSON.parse(await readFile(join(directory,'native-result.json'),'utf8').catch(error=>{throw new Error(`Native regression exited (${code}) before reporting: ${error.message}`);}));
  const result={measuredAt:new Date().toISOString(),platform:process.platform,node:process.version,...report,...(browserHoldMs ? {browserResourceSoak:summarizeBrowserResources(profileSamples,browserHoldMs)} : {})};
  const destination=process.argv[2]; if(destination) { const outputPath=resolve(destination); await mkdir(dirname(outputPath),{recursive:true}); await writeFile(outputPath,JSON.stringify(result,null,2)+'\n'); }
  console.log(JSON.stringify(result,null,2)); if(code!==0||!report.ok) throw new Error('Native regression failed');
  // Remove only the unique identifier owned by this harness, after WebView2 exits.
  if(report.appDataDir && /^sh\.vagus\.stageone\.\d+$/.test(report.appDataDir.split(/[\\/]/).at(-1))) {
    const ownedAppData = resolve(report.appDataDir);
    if(!process.env.APPDATA || dirname(ownedAppData) !== resolve(process.env.APPDATA)) throw new Error('Native regression reported an unexpected app data directory');
    await rm(ownedAppData,{recursive:true,force:true,maxRetries:10,retryDelay:300});
  }
} finally { clearTimeout(timer); await new Promise(resolve=>page.close(resolve)); if(dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.split(/[\\/]/).at(-1).startsWith('vagus-native-stage-one-')) throw new Error('Unexpected native regression cleanup directory'); await rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:300}); }

async function sampleBrowserResources(child, samples) {
  const profileRoot=join(process.env.APPDATA || join(process.env.USERPROFILE,'AppData','Roaming'),`sh.vagus.stageone.${child.pid}`);
  const profileIds=Array.from({length:3},(_,index)=>`browser-profile-${index}`);
  const startedAt=Date.now();
  const trackedProcesses=new Map();
  while(child.exitCode===null) {
    let processTree={};
    try {
      const script=`$all=Get-CimInstance Win32_Process; $ids=@([uint32]${child.pid}); $changed=$true; while($changed){$changed=$false; foreach($p in $all){$procId=[uint32]$p.ProcessId; $parentId=[uint32]$p.ParentProcessId; if(($ids -contains $parentId) -and ($ids -notcontains $procId)){$ids+= $procId; $changed=$true}}}; $procs=@($ids | ForEach-Object {$g=Get-Process -Id $_ -ErrorAction SilentlyContinue; if($g){$c=$all|Where-Object {[uint32]$_.ProcessId -eq [uint32]$g.Id}|Select-Object -First 1; [pscustomobject]@{processId=$g.Id;name=$g.ProcessName;workingSetBytes=$g.WorkingSet64;privateBytes=$g.PrivateMemorySize64;creationDate=[string]$c.CreationDate}}}); $details=@($procs|Sort-Object privateBytes -Descending|Select-Object -First 12); [pscustomobject]@{processCount=$procs.Count;workingSetBytes=[long](($procs|Measure-Object workingSetBytes -Sum).Sum);privateBytes=[long](($procs|Measure-Object privateBytes -Sum).Sum);largestPrivateProcesses=$details;processIdentities=@($procs|ForEach-Object {[pscustomobject]@{processId=$_.processId;creationDate=$_.creationDate}})}|ConvertTo-Json -Compress -Depth 4`;
      processTree=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:5000}).trim());
      for(const identity of processTree.processIdentities??[]) trackedProcesses.set(identity.processId,identity.creationDate);
    } catch(error) { processTree={error:error.message}; }
    const profiles={};
    for(const id of profileIds) profiles[id]=await directoryBytes(join(profileRoot,id,'browser-data',id));
    samples.push({elapsedMs:Date.now()-startedAt,sampledAt:new Date().toISOString(),processTree,profileBytes:profiles,totalProfileBytes:Object.values(profiles).reduce((sum,size)=>sum+size,0)});
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  const postExitSamples=[];
  for(let index=0;index<5;index++) {
    const identities=[...trackedProcesses].map(([processId,creationDate])=>({processId,creationDate}));
    const encoded=Buffer.from(JSON.stringify(identities),'utf8').toString('base64');
    const script=`$targets=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json; $all=Get-CimInstance Win32_Process; $procs=@(foreach($target in $targets){$p=$all|Where-Object {[uint32]$_.ProcessId -eq [uint32]$target.processId -and [string]$_.CreationDate -eq [string]$target.creationDate}|Select-Object -First 1; if($p){$g=Get-Process -Id ([int]$p.ProcessId) -ErrorAction SilentlyContinue; if($g){[pscustomobject]@{processId=$g.Id;name=$g.ProcessName;workingSetBytes=$g.WorkingSet64;privateBytes=$g.PrivateMemorySize64}}}}); [pscustomobject]@{processCount=$procs.Count;workingSetBytes=[long](($procs|Measure-Object workingSetBytes -Sum).Sum);privateBytes=[long](($procs|Measure-Object privateBytes -Sum).Sum);processes=@($procs|Sort-Object privateBytes -Descending|Select-Object -First 12)}|ConvertTo-Json -Compress -Depth 4`;
    let processTree={};
    try { processTree=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:5000}).trim()); }
    catch(error) { processTree={error:error.message}; }
    postExitSamples.push({elapsedMs:Date.now()-startedAt,processTree});
    if(index<4) await new Promise(resolve=>setTimeout(resolve,2000));
  }
  samples.postExit=postExitSamples;
}

async function directoryBytes(path) {
  let entries;
  try { entries=await readdir(path,{withFileTypes:true}); } catch { return 0; }
  let total=0;
  for(const entry of entries) {
    const childPath=join(path,entry.name);
    if(entry.isDirectory()) total+=await directoryBytes(childPath);
    else { try { total+=(await stat(childPath)).size; } catch { /* File changed during sampling. */ } }
  }
  return total;
}

function summarizeBrowserResources(samples,durationMs) {
  const usable=samples.filter(sample=>!sample.processTree.error && sample.processTree.processCount>0);
  const working=usable.map(sample=>sample.processTree.workingSetBytes);
  const privateBytes=usable.map(sample=>sample.processTree.privateBytes);
  const profiles=samples.map(sample=>sample.totalProfileBytes);
  const max=(values)=>values.length?Math.max(...values):null;
  const peak=samples.reduce((best,sample)=>!best||sample.processTree.privateBytes>best.processTree.privateBytes?sample:best,null);
  const compactSamples=samples.map(sample=>({elapsedMs:sample.elapsedMs,processCount:sample.processTree.processCount??null,workingSetBytes:sample.processTree.workingSetBytes??null,privateBytes:sample.processTree.privateBytes??null,totalProfileBytes:sample.totalProfileBytes}));
  const intervals=samples.slice(1).map((sample,index)=>sample.elapsedMs-samples[index].elapsedMs).filter(Number.isFinite).sort((a,b)=>a-b);
  const postExit=samples.postExit??[];
  const postExitPrivate=postExit.map(sample=>sample.processTree.privateBytes).filter(Number.isFinite);
  const compactPostExit=postExit.map(sample=>({elapsedMs:sample.elapsedMs,processCount:sample.processTree.processCount??null,workingSetBytes:sample.processTree.workingSetBytes??null,privateBytes:sample.processTree.privateBytes??null}));
  return {scope:'isolated hidden Tauri smoke app, Host, and three local fixture browser views; no keeper window or PTYs',holdMs:durationMs,targetSampleIntervalMs:2000,medianSampleIntervalMs:intervals.length?intervals[Math.floor(intervals.length/2)]:null,sampleCount:samples.length,summary:{workingSetStartBytes:working[0]??null,workingSetPeakBytes:max(working),workingSetEndBeforeExitBytes:working.at(-1)??null,privateBytesStart:privateBytes[0]??null,privateBytesPeak:max(privateBytes),privateBytesEndBeforeExitBytes:privateBytes.at(-1)??null,profileBytesStart:profiles[0]??null,profileBytesPeak:max(profiles),profileBytesEnd:profiles.at(-1)??null},peakSample:{elapsedMs:peak?.elapsedMs??null,processes:peak?.processTree.largestPrivateProcesses??[]},postExitProcessSamples:compactPostExit,postExitSummary:{remainingProcessCount:postExit.at(-1)?.processTree.processCount??null,remainingPrivateBytes:postExitPrivate.at(-1)??null},samples:compactSamples};
}
