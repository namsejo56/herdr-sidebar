const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../mods/context-inspector-261109/session-context.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/export (async )?function/g, '$1function');

test('session reader uses the explicit terminal and executes metadata reading on its machine', async () => {
  const calls = [];
  const scope = {
    hc: async args => { calls.push({args}); return {code:0,stdout:JSON.stringify({text:'GPT-example high · Context 10% used'})}; },
    readTextFile: async file => { calls.push({file}); return 'reader source'; },
    appHome: () => 'C:/app',
    exec: async (cmd,args,options) => { calls.push({cmd,args,options}); return {code:0,stdout:'{"contextPercent":10}'}; },
  };
  vm.runInNewContext(source, scope);
  const result = await scope.readSession({agent:'codex',terminal:'remote/t2',machine:'remote',cwd:'/project',sessionTitle:'session',duplicateTitle:false});
  assert.equal(result.contextPercent,10);
  assert.deepEqual(Array.from(calls[0].args),['read','remote/t2','--json','--lines','0']);
  assert.equal(calls[1].file,'C:/app/mods/context-inspector-261109/session-context.py');
  assert.equal(calls[2].options.on,'remote');assert.equal(calls[2].options.cwd,'/project');
  assert.equal(JSON.parse(calls[2].args[2]).title,'session');
  assert.ok(calls.every(call=>!call.args?.includes('send')));
});

test('reader rejects failed reads and unsupported agents do no work', async () => {
  let reads=0;
  const scope={hc:async()=>{reads++;return {code:1,stdout:''};}};
  vm.runInNewContext(source,scope);
  assert.equal(Object.keys(await scope.readSession({agent:'opencode',terminal:'t1'})).length,0);
  assert.equal(reads,0);
  await assert.rejects(scope.readSession({agent:'codex',terminal:'t1'}),/terminal status/);
});
test('session controls keep the remote target and only publish verified updates',async()=>{
 const calls=[];
 const scope={readTextFile:async()=> 'control reader',appHome:()=> 'C:/app',
  exec:async(cmd,args,options)=>{calls.push({cmd,args,options});return {code:0,stdout:'{"state":{"model":"selected"},"verified":true}'};}};
 vm.runInNewContext(source,scope);
 const current={agent:'codex',terminal:'remote/t2',machine:'remote',cwd:'/project'};
 await scope.controlSession(current,'sid','update','effort','high',{effort:'low'});
 assert.equal(scope.sessionRevision(),1);assert.equal(calls[0].options.on,'remote');
 const request=JSON.parse(calls[0].args[2]);assert.equal(request.session,'sid');assert.equal(request.field,'effort');
 assert.equal(request.expected.effort,'low');
 scope.exec=async()=>({code:0,stdout:'{"state":{}}'});
 await assert.rejects(scope.controlSession(current,'sid','update','effort','high'),/verified/);
 assert.equal(scope.sessionRevision(),1);
});
test('live settings override stale log settings while failed controls preserve passive metadata',async()=>{
 let available=true;
 const scope={hc:async()=>({code:0,stdout:JSON.stringify({text:'GPT-example high · Context 10% used'})}),
  readTextFile:async()=> 'reader',appHome:()=> 'C:/app',exec:async(cmd,args)=>{
   const request=JSON.parse(args[2]);
   return {code:0,stdout:request.operation?JSON.stringify(available?{state:{model:'current',effort:'low',mode:'plan'}}:{error:'unavailable'}):'{"session":"sid","model":"old","effort":"high"}'};
  }};
 vm.runInNewContext(source,scope);
 const current={agent:'codex',terminal:'t2',cwd:'C:/project'};
 let snapshot=await scope.readSession(current);assert.equal(snapshot.model,'current');assert.equal(snapshot.effort,'low');assert.equal(snapshot.controlsAvailable,true);
 available=false;snapshot=await scope.readSession(current);assert.equal(snapshot.model,'old');assert.equal(snapshot.controlError,'unavailable');
});
function optionsHarness() {
 const calls=[];
 const state={model:'example',effort:'high',mode:'default'};
 const scope={readTextFile:async()=> 'reader',appHome:()=> 'C:/app',exec:async(cmd,args,options)=>{
  const request=JSON.parse(args[2]);calls.push(request);
  return {code:0,stdout:JSON.stringify({state:{...state},choices:[{id:'example',efforts:['low','high']}],verified:request.operation==='update'})};
 }};
 vm.runInNewContext(source,scope);
 return {scope,calls,state,current:{agent:'codex',terminal:'t1',machine:null,cwd:'C:/project'}};
}
test('dropdown catalogs work without a session and Model shares its catalog across sessions with Effort',async()=>{
 const h=optionsHarness();
 assert.equal(h.scope.cachedSessionOptions(h.current,'sid','model'),null);
 await h.scope.controlSession(h.current,null,'options','model');
 assert.ok(h.scope.cachedSessionOptions(h.current,'sid','effort'));
 await h.scope.controlSession(h.current,'sid','options','model');
 await h.scope.controlSession(h.current,'other','options','effort');
 assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].session,null);
 assert.equal(h.scope.cachedSessionOptions(h.current,'other','model').state,null);
});
test('live reads and verified saves update cached settings without discarding choices',async()=>{
 const h=optionsHarness();await h.scope.controlSession(h.current,'sid','options','model');
 h.state.effort='low';await h.scope.controlSession(h.current,'sid','read');
 assert.equal(h.scope.cachedSessionOptions(h.current,'sid','model').state.effort,'low');
 h.state.effort='high';await h.scope.controlSession(h.current,'sid','update','effort','high',{});
 assert.equal(h.scope.cachedSessionOptions(h.current,'sid','effort').state.effort,'high');
 await h.scope.controlSession(h.current,'sid','options','effort');
 assert.equal(h.calls.filter(x=>x.operation==='options').length,1);
});
test('Refresh invalidates the shared catalog and failed option loads can retry',async()=>{
 const h=optionsHarness();
 await h.scope.controlSession(h.current,'sid','options','mode');
 await h.scope.controlSession(h.current,'other','options','mode');
 h.scope.invalidateSessionOptions(h.current,'sid');
 assert.equal(h.scope.cachedSessionOptions(h.current,'sid','mode'),null);
 assert.equal(h.scope.cachedSessionOptions(h.current,'other','mode'),null);
 const exec=h.scope.exec;h.scope.exec=async()=>({code:0,stdout:'{"error":"unavailable"}'});
 await assert.rejects(h.scope.controlSession(h.current,'sid','options','mode'),/unavailable/);
 h.scope.exec=exec;await h.scope.controlSession(h.current,'sid','options','mode');
 assert.ok(h.scope.cachedSessionOptions(h.current,'sid','mode'));
});
test('simultaneous Model and Effort opens share one pending request',async()=>{
 const h=optionsHarness();let done;
 h.scope.exec=async()=>new Promise(resolve=>{h.calls.push('options');done=resolve;});
 const model=h.scope.controlSession(h.current,'sid','options','model');
 const effort=h.scope.controlSession(h.current,'sid','options','effort');
 await new Promise(setImmediate);assert.equal(h.calls.length,1);
 done({code:0,stdout:JSON.stringify({state:h.state,choices:[{id:'shared'}]})});
 const results=await Promise.all([model,effort]);assert.equal(results[0].choices,results[1].choices);
});
test('an invalidated pending result cannot replace a newer options cache',async()=>{
 const h=optionsHarness(),pending=[];
 h.scope.exec=async()=>new Promise(resolve=>pending.push(resolve));
 const old=h.scope.controlSession(h.current,'sid','options','mode');await new Promise(setImmediate);
 h.scope.invalidateSessionOptions(h.current,'sid');
 const fresh=h.scope.controlSession(h.current,'sid','options','mode');await new Promise(setImmediate);
 pending[0]({code:0,stdout:JSON.stringify({state:h.state,choices:[{id:'old'}]})});await old;
 assert.equal(h.scope.cachedSessionOptions(h.current,'sid','mode'),null);
 pending[1]({code:0,stdout:JSON.stringify({state:h.state,choices:[{id:'new'}]})});await fresh;
 assert.equal(h.scope.cachedSessionOptions(h.current,'sid','mode').choices[0].id,'new');
});
test('a slow earlier read cannot overwrite settings from a verified save',async()=>{
 const h=optionsHarness();await h.scope.controlSession(h.current,'sid','options','model');
 const exec=h.scope.exec;let done;
 h.scope.exec=async(cmd,args,options)=>JSON.parse(args[2]).operation==='read'
  ? new Promise(resolve=>{done=resolve;}) : exec(cmd,args,options);
 const old=h.scope.controlSession(h.current,'sid','read');await new Promise(setImmediate);
 h.state.effort='low';await h.scope.controlSession(h.current,'sid','update','effort','low',{});
 done({code:0,stdout:'{"state":{"effort":"high"}}'});const result=await old;
 assert.equal(result.state.effort,'low');assert.equal(h.scope.cachedSessionOptions(h.current,'sid','model').state.effort,'low');
});
test('catalogs isolate machine and folder while settings stay isolated by session',async()=>{
 const h=optionsHarness();await h.scope.controlSession(h.current,'sid','options','mode');
 await h.scope.controlSession({...h.current,terminal:'t2'},'sid','options','mode');assert.equal(h.calls.length,1);
 for(const current of [{...h.current,machine:'remote'}, {...h.current,cwd:'C:/another'}]){
  assert.equal(h.scope.cachedSessionOptions(current,'sid','mode'),null);
  await h.scope.controlSession(current,'sid','options','mode');
 }
 h.state.effort='low';await h.scope.controlSession(h.current,'sid','read');
 assert.equal(h.scope.cachedSessionOptions(h.current,'sid','mode').state.effort,'low');
 assert.equal(h.scope.cachedSessionOptions(h.current,'other','mode').state,null);
 assert.ok(h.scope.cachedSessionOptions(h.current,'other','mode').choices);
 assert.equal(h.calls.filter(call=>call.operation==='options').length,3);
});
test('option contexts are bounded and an empty catalog remains a valid cache hit',async()=>{
 const h=optionsHarness();
 h.scope.exec=async()=>{h.calls.push('options');return {code:0,stdout:JSON.stringify({state:h.state,choices:[]})};};
 for(let i=0;i<33;i++)await h.scope.controlSession({...h.current,cwd:`C:/p${i}`},null,'options','mode');
 assert.equal(h.scope.cachedSessionOptions({...h.current,cwd:'C:/p0'},null,'mode'),null);
 assert.equal(h.scope.cachedSessionOptions({...h.current,cwd:'C:/p32'},null,'mode').choices.length,0);
 await h.scope.controlSession({...h.current,cwd:'C:/p32'},null,'options','mode');assert.equal(h.calls.length,33);
});

const bridge=(extra={})=>({version:1,terminal:'t2',sessionId:'sid',cwd:'/project',model:'claude-opus-5-5',effort:'high',permissionMode:'auto',
 context:{tokens:113000,window:1000000,percent:11},
 rateLimits:[{kind:'five_hour',percentUsed:14,resetsAt:'2026-11-13T08:00:00.000Z'},{kind:'seven_day',percentUsed:19,resetsAt:'not a date'},{kind:'spend_limit',percentUsed:5}],
 choices:{model:['opus','sonnet'],effort:['low','high']},updatedAt:1,...extra});
const isWrite=args=>String(args?.[2]??'').includes('os.replace');
function claudeHarness(snapshot=bridge()){
 const calls=[],state={snapshot,raw:null,onWrite:null,written:[]};let clock=1000;
 const scope={
  hc:async args=>{calls.push({hc:args});return {code:1,stdout:''};},
  readTextFile:async()=>{calls.push({readTextFile:true});return null;},appHome:()=> 'C:/app',
  setTimeout:(fn,ms)=>{clock+=ms;setImmediate(fn);},
  Date:class extends Date{static now(){return clock;}},
  exec:async(cmd,args,options)=>{calls.push({cmd,args,options});
   if(isWrite(args)){const request=JSON.parse(args[4]);state.written.push(request);state.onWrite?.(request);return {code:0,stdout:'ok'};}
   return {code:0,stdout:state.raw??JSON.stringify(state.snapshot)};}};
 vm.runInNewContext(source,scope);
 return {scope,calls,state,current:{agent:'claude-code',terminal:'remote/t2',machine:'remote',cwd:'/project'}};
}
test('Claude reader reads the bridge snapshot on the terminal machine and maps every field',async()=>{
 const h=claudeHarness();const s=await h.scope.readSession(h.current);
 assert.equal(h.calls.length,1);assert.equal(h.calls[0].cmd,'python');assert.deepEqual(Array.from(h.calls[0].args.slice(0,2)),['-I','-c']);
 assert.equal(h.calls[0].args[3],'t2');assert.equal(h.calls[0].options.on,'remote');assert.equal(h.calls[0].options.cwd,undefined,'no project cwd on the import path');
 assert.match(h.calls[0].args[2],/Path\.home\(\)/);
 assert.equal(s.session,'sid');assert.equal(s.model,'claude-opus-5-5');assert.equal(s.effort,'high');assert.equal(s.permission,'auto');
 assert.equal(s.contextPercent,11);assert.equal(s.contextWindow,1000000);assert.equal(s.contextTokens,113000);
 assert.deepEqual(JSON.parse(JSON.stringify(s.quota)),[{minutes:300,used:14,reset:Date.parse('2026-11-13T08:00:00.000Z')/1000},{minutes:10080,used:19,reset:null}]);
 assert.deepEqual(Array.from(s.choices.model),['opus','sonnet']);assert.equal(s.lastRequest,null);
 assert.ok(h.calls.every(call=>!call.hc&&!call.readTextFile),'Claude never reads the terminal screen or the Codex reader');
});
test('Claude reader reports a missing mod and omits unreadable fields instead of guessing',async()=>{
 const h=claudeHarness();h.state.raw='null';
 assert.deepEqual({...await h.scope.readSession(h.current)},{bridgeMissing:true});
 h.state.raw=JSON.stringify({version:1,terminal:'t2',choices:{}});
 const s=await h.scope.readSession(h.current);
 assert.equal(s.model,undefined);assert.equal(s.effort,undefined);assert.equal(s.contextPercent,undefined);assert.equal(s.quota.length,0);
});
test('an ended Claude snapshot reads as not running and blocks changes',async()=>{
 const h=claudeHarness();h.state.raw=JSON.stringify(bridge({ended:true}));
 assert.deepEqual({...await h.scope.readSession(h.current)},{bridgeEnded:true});
 await assert.rejects(h.scope.controlSession(h.current,'sid','options','model'),/not running/);
});
test('a failed read keeps the last whole snapshot',async()=>{
 const h=claudeHarness();await h.scope.readSession(h.current);
 h.scope.exec=async()=>({code:1,stdout:''});assert.equal((await h.scope.readSession(h.current)).session,'sid');
 const fresh=claudeHarness();fresh.scope.exec=async()=>({code:1,stdout:''});await assert.rejects(fresh.scope.readSession(fresh.current),/Could not read/);
});
test('Claude reader keeps the last whole snapshot across a torn read and rejects foreign snapshots',async()=>{
 const h=claudeHarness();
 h.state.raw='{"version":1,"termi';await assert.rejects(h.scope.readSession(h.current));
 h.state.raw=null;await h.scope.readSession(h.current);
 h.state.raw='{"version":1,"termi';assert.equal((await h.scope.readSession(h.current)).session,'sid');
 for(const raw of [bridge({version:2}),bridge({terminal:'t3'}),[]]){h.state.raw=JSON.stringify(raw);await assert.rejects(h.scope.readSession(h.current),/Unsupported/);}
 for(const terminal of ['remote/','remote/..','remote/t 2'])await assert.rejects(h.scope.readSession({...h.current,terminal}),/Unsupported terminal/);
});
test('Claude options come from the snapshot and a read primes the synchronous cache',async()=>{
 const h=claudeHarness();
 assert.equal(h.scope.cachedSessionOptions(h.current,'sid','model'),null);
 const options=await h.scope.controlSession(h.current,'sid','options','effort');
 assert.deepEqual(JSON.parse(JSON.stringify(options.choices)),[{id:'low',name:'low'},{id:'high',name:'high'}]);
 const cached=h.scope.cachedSessionOptions(h.current,'sid','model');assert.equal(cached.choices[1].id,'sonnet');
 assert.equal(h.scope.cachedSessionOptions(h.current,'sid','mode'),null);
 await assert.rejects(h.scope.controlSession(h.current,'sid','options','permissions'),/Only Model and Effort/);
});
test('a Claude update writes one request and resolves only on its confirmed result',async()=>{
 const h=claudeHarness();
 h.state.onWrite=request=>{h.state.snapshot=bridge({effort:'low',lastRequest:{id:request.id,ok:true,error:null}});};
 const result=await h.scope.controlSession(h.current,'sid','update','effort','low',{effort:'high'});
 assert.equal(result.verified,true);assert.equal(result.state.effort,'low');assert.equal(h.scope.sessionRevision(),1);
 assert.equal(h.state.written.length,1);
 const [request]=h.state.written;assert.match(request.id,/^r-[a-z0-9]+$/);
 assert.deepEqual({...request,id:null},{version:1,id:null,sessionId:'sid',field:'effort',value:'low'});
 const write=h.calls.find(call=>isWrite(call.args));assert.equal(write.args[0],'-I');assert.equal(write.args[3],'t2');assert.equal(write.options.on,'remote');assert.equal(write.options.cwd,undefined);
 assert.ok(h.calls.every(call=>!call.hc));
});
test('a Claude update waits through a pending result and surfaces a rejection',async()=>{
 const h=claudeHarness();let reads=0;
 h.state.onWrite=request=>{h.state.pendingId=request.id;};
 const exec=h.scope.exec;h.scope.exec=async(cmd,args,options)=>{
  if(!isWrite(args)){reads++;h.state.snapshot=bridge({lastRequest:{id:h.state.pendingId,ok:reads<3?null:false,error:reads<3?null:'That model is not offered by this Claude session.'}});}
  return exec(cmd,args,options);};
 await assert.rejects(h.scope.controlSession(h.current,'sid','update','model','sonnet'),/not offered/);
 assert.equal(reads,3);assert.equal(h.scope.sessionRevision(),0);
});
test('a Claude update times out with the idle explanation and never sends keys',async()=>{
 const h=claudeHarness();
 await assert.rejects(h.scope.controlSession(h.current,'sid','update','model','sonnet'),/applies when Claude is idle/);
 assert.equal(h.state.written.length,1);
 assert.ok(h.calls.every(call=>!call.hc&&!call.args?.includes('send')&&!call.args?.includes('keys')));
 await assert.rejects(h.scope.controlSession(h.current,null,'update','model','sonnet'),/not identified/);
 h.scope.exec=async()=>({code:1,stdout:''});
 await assert.rejects(h.scope.controlSession(h.current,'sid','update','model','sonnet'),/Could not send/);
});
