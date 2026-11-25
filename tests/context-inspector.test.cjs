const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../mods/context-inspector-261109/main.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace('export default class Inspector', 'class Inspector') + '\nthis.Inspector = Inspector;';
function harness() {
  const pending = [];
  const timers = [], delays = [];
  const state = { time: 100000, notices: 0, spaces: [{id:'s',machine:null}], focus: { space:'s', pane:'p', terminal:'t1', cwd:'C:/p' }, pane: { pane:'p', terminal:'t1', app:'claude-code', cwd:'C:/p', program:{name:'Claude Code'} } };
  const scope = { View: class {}, Date: class extends Date { static now(){return state.time;} }, spaces: () => state.spaces, panes: () => [state.pane], terminals: () => [], focused: () => state.focus,
    readTextFile: () => new Promise(resolve => pending.push(resolve)), exec: async () => ({code:1,stdout:''}),
    connection:()=>({result:null,job:null}), setConnectionVersion(){},
    readSession:async()=>({}), sessionRevision:()=>0, permissionLabel:id=>id??'Unavailable', invalidateSessionOptions(){},
    theme: () => ({}), props: () => ({}), openOverlay:()=>{}, closeOverlay:()=>{}, div:()=>{}, h_flex:()=>{}, v_flex:()=>{}, console };
  vm.runInNewContext(source, scope);
  const jobs=[]; const cx = { spawn: fn => jobs.push(fn(cx)), notify(){state.notices++;}, timer:{ every(ms, fn){timers.push({ms, fn});}, after(ms,fn){delays.push({ms,fn});} } };
  return { instance: new scope.Inspector(), state, pending, jobs, cx, timers, delays, scope,
    async settle(){ for(let i=0;i<jobs.length;i++) await jobs[i]; },
    poll(){state.time+=10000;timers[0].fn(cx);} };
}
test('switching terminals in one space keeps MCP data and performs no extra read', async () => {
 const h=harness(); h.instance.init({},h.cx);
 h.pending[0](JSON.stringify({mcpServers:{cached:{}}})); await h.jobs[0];
 h.state.focus.terminal='t2'; h.state.pane.terminal='t2';
 h.instance.refresh(h.cx, false);
 assert.deepEqual(Array.from(h.instance.entries), ['cached']);
 assert.equal(h.instance.loading, false); assert.equal(h.pending.length,1);
});
test('session snapshots are isolated by terminal while MCP remains shared', async()=>{
 const h=harness();h.state.pane.app='codex';const pending=[];
 h.scope.exec=async cmd=>({code:0,stdout:cmd==='node'?'a'.repeat(64):'[]'});
 h.scope.readSession=current=>new Promise(resolve=>pending.push({terminal:current.terminal,resolve}));
 h.instance.init({},h.cx);h.pending[0](null);await h.jobs[0];
 h.state.focus.terminal='t2';h.state.pane.terminal='t2';h.instance.refresh(h.cx,false);
 assert.equal(h.instance.session,null);assert.equal(pending.length,2);
 pending[0].resolve({contextPercent:70,session:'first'});await Promise.resolve();await Promise.resolve();
 assert.equal(h.instance.session,null,'old terminal cannot publish into the new one');
 pending[1].resolve({contextPercent:10,session:'second'});await h.settle();
 assert.equal(h.instance.session.session,'second');assert.equal(h.pending.length,1);
 h.state.focus.terminal='t1';h.state.pane.terminal='t1';h.instance.refresh(h.cx,false);
 assert.equal(h.instance.session.session,'first');assert.equal(pending.length,2);
 h.instance.close();h.poll();assert.equal(pending.length,2);
});
test('session polling and Refresh update data even when MCP fails',async()=>{
 const h=harness();h.state.pane.app='codex';let reads=0,fail=false;
 h.scope.exec=async()=>({code:1,stdout:''});
 h.scope.readSession=async()=>{reads++;if(fail)throw new Error();return {contextPercent:reads};};
 h.instance.init({},h.cx);h.pending[0]('bad json');await h.settle();
 assert.equal(h.instance.session.contextPercent,1);assert.ok(h.instance.error);
 h.poll();h.pending[1]('bad json');await h.settle();assert.equal(h.instance.session.contextPercent,2);
 fail=true;h.instance.refresh(h.cx);h.pending[2]('bad json');await h.settle();
 assert.equal(h.instance.session,null);assert.match(h.instance.sessionError,/Refresh/);
 fail=false;h.instance.refresh(h.cx);h.pending[3]('bad json');await h.settle();assert.equal(h.instance.session.contextPercent,4);
});

test('in-flight work is shared between terminals and inspector copies', async () => {
 const h=harness(); h.instance.init({},h.cx);
 h.state.focus.terminal='t2'; h.state.pane.terminal='t2'; h.instance.refresh(h.cx,false);
 const second=new h.scope.Inspector(); second.init({},h.cx);
 assert.equal(h.pending.length,1);
 h.pending[0](JSON.stringify({mcpServers:{shared:{}}})); await h.settle();
 assert.deepEqual(Array.from(h.instance.entries),['shared']);
 assert.deepEqual(Array.from(second.entries),['shared']);
 assert.equal(h.instance.current.terminal,'t2');
});

test('spaces, machines, folders and agent types have isolated cached results', async () => {
 const h=harness(); h.instance.init({},h.cx);
 h.pending[0]('{"mcpServers":{"original":{}}}');await h.settle();
 for (const change of [()=>{h.state.focus.space='other';h.state.spaces.push({id:'other',machine:null});},
   ()=>{h.state.spaces[1].machine='remote';},()=>{h.state.focus.cwd='C:/q';},()=>{h.state.pane.app=null;}]) {
   change();h.instance.refresh(h.cx,false);assert.deepEqual(Array.from(h.instance.entries),[]);
   h.pending.at(-1)('{"mcpServers":{"other":{}}}');await h.settle();
 }
 h.state.focus.space='s';h.state.focus.cwd='C:/p';h.state.pane.app='claude-code';
 const reads=h.pending.length; h.instance.refresh(h.cx,false);
 assert.deepEqual(Array.from(h.instance.entries),['original']);assert.equal(h.pending.length,reads);
});

test('background checks retain stable data, apply changes and recover from malformed config', async () => {
 const h=harness();h.instance.init({},h.cx);h.pending[0]('{"mcpServers":{"first":{}}}');await h.settle();
 const entries=h.instance.entries, notices=h.state.notices;
 h.poll();assert.equal(h.instance.loading,false);assert.equal(h.instance.entries,entries);
 h.pending[1]('{"mcpServers":{"first":{}}}');await h.settle();
 assert.equal(h.instance.entries,entries);assert.equal(h.state.notices,notices);
 h.poll();h.pending[2]('bad json');await h.settle();
 assert.equal(h.instance.entries,entries);assert.match(h.instance.error,/cached/);
 h.poll();h.pending[3]('{"mcpServers":{"second":{}}}');await h.settle();
 assert.deepEqual(Array.from(h.instance.entries),['second']);assert.equal(h.instance.error,null);
 h.poll();h.pending[4](null);await h.settle();assert.deepEqual(Array.from(h.instance.entries),[]);
});

test('Codex publishes MCP before slow quota and reuses both when switching terminals', async () => {
 const h=harness();h.state.pane.app='codex';let quotaDone; const calls=[];
 h.scope.exec=(cmd,args,options)=>{
   calls.push({cmd,args,options});
   if(cmd==='node')return Promise.resolve({code:0,stdout:'a'.repeat(64)});
   if(cmd==='codex')return Promise.resolve({code:0,stdout:'[{"name":"global"}]'});
   return new Promise(resolve=>{quotaDone=resolve;});
 };
 h.instance.init({},h.cx);h.pending[0]('{"mcpServers":{"project":{}}}');await h.jobs[0];
 assert.deepEqual(Array.from(h.instance.entries),['global','project']);assert.equal(h.instance.loading,false);
 h.state.focus.terminal='t2';h.state.pane.terminal='t2';h.instance.refresh(h.cx,false);
 assert.equal(h.pending.length,1);assert.equal(calls.length,3);
 quotaDone({code:0,stdout:'[{"minutes":300,"used":42}]'});await h.settle();
 assert.equal(h.instance.quota[0].used,42);assert.equal(calls.length,3);
});

test('unchanged Codex sources skip list and quota, changed sources refresh only MCP', async () => {
 const h=harness();h.state.pane.app='codex';let stamp='a',name='first';const calls=[];
 h.scope.exec=async(cmd,args,options)=>{
   calls.push({cmd,args,options});
   return {code:0,stdout:cmd==='node'?stamp.repeat(64):cmd==='codex'?JSON.stringify([{name}]):'[]'};
 };
 h.instance.init({},h.cx);h.pending[0](null);await h.settle();
 h.poll();h.pending[1](null);await h.settle();
 assert.equal(calls.filter(x=>x.cmd==='codex').length,1);assert.equal(calls.filter(x=>x.cmd==='python').length,1);
 stamp='b';name='second';h.poll();h.pending[2](null);await h.settle();
 assert.deepEqual(Array.from(h.instance.entries),['second']);
 assert.equal(calls.filter(x=>x.cmd==='codex').length,2);assert.equal(calls.filter(x=>x.cmd==='python').length,1);
});

test('missing Node falls back to Codex listing and remote reads stay on the target machine', async () => {
 const h=harness();h.state.pane.app='codex';h.state.spaces[0].machine='remote';const calls=[];
 h.scope.readTextFile=async(file,options)=>{calls.push({file,options});return null;};
 h.scope.exec=async(cmd,args,options)=>{
   calls.push({cmd,options});if(cmd==='node')throw new Error('not installed');
   return {code:0,stdout:cmd==='codex'?'[{"name":"remote-server"}]':'[]'};
 };
 h.instance.init({},h.cx);await h.settle();
 assert.deepEqual(Array.from(h.instance.entries),['remote-server']);
 assert.ok(calls.every(x=>x.options.on==='remote'));
 h.instance.refresh(h.cx,false);assert.equal(calls.filter(x=>x.cmd==='codex').length,1);
 h.poll();await h.settle();assert.equal(calls.filter(x=>x.cmd==='codex').length,2);
});

test('a failed Codex list retains valid names and retries the changed stamp', async () => {
 const h=harness();h.state.pane.app='codex';let failed=false,stamp='a';let lists=0;
 h.scope.exec=async cmd=>{
   if(cmd==='node')return {code:0,stdout:stamp.repeat(64)};
   if(cmd==='codex'){lists++;return {code:failed?1:0,stdout:'[{"name":"saved"}]'};}
   return {code:0,stdout:'[]'};
 };
 h.instance.init({},h.cx);h.pending[0](null);await h.settle();
 stamp='b';failed=true;h.poll();h.pending[1](null);await h.settle();
 assert.deepEqual(Array.from(h.instance.entries),['saved']);assert.match(h.instance.error,/cached/);
 failed=false;h.poll();h.pending[2](null);await h.settle();assert.equal(lists,3);assert.equal(h.instance.error,null);
});

test('closing the view suppresses notifications and preserves its completed cache', async () => {
 const h=harness();h.instance.init({},h.cx);h.instance.close();
 h.pending[0]('{"mcpServers":{"saved":{}}}');await h.settle();assert.equal(h.state.notices,0);
 const next=new h.scope.Inspector();next.init({},h.cx);
 assert.deepEqual(Array.from(next.entries),['saved']);assert.equal(h.pending.length,1);
});

test('real config fingerprint detects user, profile, ancestor, create and delete changes without emitting values', () => {
 const os=require('node:os'), {execFileSync}=require('node:child_process');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-context-stamp-'));
 try {
   const user=path.join(root,'user'),project=path.join(root,'project'),cwd=path.join(project,'nested');
   fs.mkdirSync(user);fs.mkdirSync(cwd,{recursive:true});fs.mkdirSync(path.join(project,'.codex'));
   const scope={};vm.runInNewContext(source.replace('class Inspector extends View','class Inspector extends Object'),scope);
   const script=`(${scope.codexConfigStamp.toString()})()`;
   const stamp=()=>execFileSync(process.execPath,['-e',script],{cwd,env:{...process.env,CODEX_HOME:user,ProgramData:path.join(root,'system')},encoding:'utf8'}).trim();
   const first=stamp();assert.match(first,/^[a-f0-9]{64}$/);assert.equal(stamp(),first);
   const userFile=path.join(user,'config.toml');fs.writeFileSync(userFile,'secret = "never-print-this"');const second=stamp();assert.notEqual(second,first);
   const profile=path.join(user,'work.config.toml');fs.writeFileSync(profile,'enabled = true');const third=stamp();assert.notEqual(third,second);
   fs.writeFileSync(profile,'enabled = false');const fourth=stamp();assert.notEqual(fourth,third);
   const ancestor=path.join(project,'.codex','config.toml');fs.writeFileSync(ancestor,'enabled = true');assert.notEqual(stamp(),fourth);
   fs.unlinkSync(ancestor);assert.equal(stamp(),fourth);fs.unlinkSync(profile);assert.equal(stamp(),second);
   assert.ok(!second.includes('never-print-this'));
 } finally {
   assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
   assert.ok(path.basename(root).startsWith('herdr-context-stamp-'));fs.rmSync(root,{recursive:true,force:true});
 }
});
test('older refresh for the same terminal cannot overwrite a newer result', async () => {
 const h=harness(); h.instance.init({},h.cx); h.instance.refresh(h.cx);
 h.pending[1](JSON.stringify({mcpServers:{newer:{}}})); await h.jobs[1];
 h.pending[0](JSON.stringify({mcpServers:{older:{}}})); await h.jobs[0];
 assert.deepEqual(Array.from(h.instance.entries), ['newer']);
});
test('focus changes cannot publish another terminal result', async () => {
 const h=harness(); h.instance.init({},h.cx);
 h.state.focus={space:'s',pane:'q',terminal:'t2',cwd:'C:/q'}; h.state.pane={pane:'q',terminal:'t2',app:'claude-code',program:{name:'Claude Code'}};
 h.instance.refresh(h.cx);
 h.pending[0](JSON.stringify({mcpServers:{old:{}}})); await h.jobs[0];
 h.pending[1](JSON.stringify({mcpServers:{current:{}}})); await h.jobs[1];
 assert.deepEqual(Array.from(h.instance.entries), ['current']);
});
test('shown terminal does not inherit a different pane agent', async () => {
 const h=harness(); h.state.focus={space:'s',pane:'p',terminal:'t2',cwd:'C:/q'};
 h.instance.init({},h.cx);
 assert.equal(h.instance.current.terminal, 't2');
 assert.equal(h.instance.current.agent, null);
 h.pending[0](null); await h.jobs[0];
});

test('real connection helper is shared by Context and details and invalidates when project config changes',async()=>{
 const h=harness();h.state.pane.app='codex';let probes=0;
 const helper=fs.readFileSync(path.join(__dirname,'../mods/context-inspector-261109/mcp-connection.js'),'utf8')
   .replace(/^import .*;\r?\n/gm,'').replace(/export function /g,'function ');
 vm.runInNewContext(`(()=>{${helper}\nObject.assign(globalThis,{connection,setConnectionVersion,connectionVersion});})();`,h.scope);
 h.scope.exec=async(cmd,args)=>{
   if(cmd==='codex')return {code:0,stdout:'[{"name":"wanted"}]'};
   if(cmd==='python')return {code:0,stdout:'[]'};
   if(args[1].includes('codexProbe')){probes++;return {code:0,stdout:'{"status":"connected","tools":[]}'};}
   return {code:0,stdout:'a'.repeat(64)};
 };
 h.instance.init({},h.cx);h.pending[0]('{"mcpServers":{}}');await h.settle();
 const check=h.instance.connections.get('wanted');assert.equal(check.result.health,'Connected');assert.equal(probes,1);
 const detailsSource=fs.readFileSync(path.join(__dirname,'../mods/context-inspector-261109/mcp-details.js'),'utf8')
   .replace(/^import .*;\r?\n/gm,'').replace('export default class McpDetails','class McpDetails')+'\nthis.McpDetails=McpDetails;';
 vm.runInNewContext(detailsSource,h.scope);
 const details=new h.scope.McpDetails();details.init({server:'wanted',space:'s',terminal:'t1',cwd:'C:/p',agent:'codex',version:h.instance.connectionVersion},h.cx);
 assert.equal(details.check,check);assert.equal(probes,1);
 h.state.focus.terminal='t2';h.state.pane.terminal='t2';h.instance.refresh(h.cx,false);
 assert.equal(h.instance.connections.get('wanted'),check);assert.equal(probes,1);
 h.poll();h.pending[1]('{"mcpServers":{"wanted":{"command":"changed"}}}');await h.settle();
 assert.notEqual(h.instance.connections.get('wanted'),check);assert.equal(probes,2);
 details.close();
});

test('closing the popup closes its connection owner',()=>{
 const h=harness();let closed=false;
 h.scope.McpDetails=class {init(){}close(){closed=true;}render(){return 'details';}};
 h.instance.init({server:'wanted'},h.cx);assert.equal(h.instance.render(),'details');
 h.instance.close();assert.equal(closed,true);
});

test('overlay props select MCP details even when native init receives no server props',()=>{
 const h=harness();let received;
 h.scope.props=()=>({server:'wanted',space:'s',terminal:'t1',cwd:'C:/p',agent:'codex',overlay:'mcp-dialog'});
 h.scope.McpDetails=class {init(p){received=p;}render(){return 'MCP details';}};
 h.instance.init({},h.cx);
 assert.equal(h.instance.popup,true);
 assert.equal(h.instance.render(),'MCP details');
 assert.equal(received.server,'wanted');assert.equal(received.overlay,'mcp-dialog');
 assert.equal(h.pending.length,0,'a details popup must not start the Context list loader');
});
test('session dropdowns replace one another and dismiss on focus changes',async()=>{
 const h=harness(),pickers=[];
 h.scope.SessionControls=class {init(p,cx,onClose){this.current=p;this.field=p.control;this.onClose=onClose;pickers.push(this);}close(){this.closed=true;}};
 h.instance.init({},h.cx);h.pending[0](null);await h.settle();
 const current={...h.instance.current};
 h.instance.setControl('model',current,'sid',true,h.cx);
 assert.equal(h.instance.sessionControl.field,'model');
 h.instance.setControl('effort',current,'sid',true,h.cx);
 assert.equal(pickers[0].closed,true);assert.equal(h.instance.sessionControl.field,'effort');
 h.instance.setControl('model',current,'sid',false,h.cx);
 assert.equal(h.instance.sessionControl.field,'effort','late dismissal from another field is ignored');
 h.instance.setControl('effort',current,'sid',false,h.cx);assert.equal(h.instance.sessionControl,null);
 h.instance.setControl('mode',current,'sid',true,h.cx);
 h.state.focus.terminal='t2';h.state.pane.terminal='t2';h.instance.refresh(h.cx,false);
 assert.equal(h.instance.sessionControl,null);assert.equal(pickers.at(-1).closed,true);
 h.instance.setControl('model',current,'sid',true,h.cx);assert.equal(h.instance.sessionControl,null,'a stale trigger cannot open a menu');
});
test('explicit Refresh invalidates dropdown options while ordinary sync preserves them',async()=>{
 const h=harness(),invalidated=[];h.state.pane.app='codex';
 h.scope.readSession=async()=>({session:'sid'});
 h.scope.exec=async cmd=>({code:0,stdout:cmd==='node'?'a'.repeat(64):'[]'});
 h.scope.invalidateSessionOptions=(current,session)=>invalidated.push({current,session});
 h.instance.init({},h.cx);h.pending[0](null);await h.settle();
 h.instance.refresh(h.cx,false);assert.equal(invalidated.length,0);
 h.instance.refresh(h.cx);h.pending[1](null);await h.settle();
 assert.equal(invalidated.length,1);assert.equal(invalidated[0].session,'sid');assert.equal(invalidated[0].current.terminal,'t1');
});
test('session rows use anchored dropdowns with captured targets and no dialogs',()=>{
 const h=harness(),nodes=[],toggles=[],overlays=[];
 const element=()=>{
  const node={};nodes.push(node);let proxy;
  proxy=new Proxy(node,{get(_t,key){
   if(key==='when')return (condition,fn)=>condition?fn(proxy):proxy;
   if(key==='id')return value=>{node.id=value;return proxy;};
   if(key==='on_click')return fn=>{node.click=fn;return proxy;};
   if(key==='on_open_change')return fn=>{node.toggle=fn;return proxy;};
   if(key==='child')return value=>{(node.children??=[]).push(value);return proxy;};
   return ()=>proxy;
  }});return proxy;
 };
 h.scope.div=element;h.scope.v_flex=element;h.scope.h_flex=element;
 h.scope.svg=element;
 h.scope.Popover={new:id=>element().id(id)};
 h.scope.Popup={new:(id,trigger)=>element().id(id).child(trigger)};
 h.scope.Progress=h.scope.ProgressTrack=h.scope.ProgressIndicator={new:element};
 h.scope.openOverlay=p=>overlays.push(p);
 h.instance.setControl=(...args)=>toggles.push(args);
 h.instance.current={space:'s',terminal:'t1',agent:'codex',cwd:'C:/p'};
 h.instance.session={session:'sid',model:'example',effort:'high',mode:'plan',permission:':workspace',contextPercent:10,last:{},total:{}};
 h.instance.sessionContent({});h.instance.current.terminal='t2';
 for(const field of ['model','effort','mode','permissions']){
  nodes.find(n=>n.id===`session-dropdown-${field}`).toggle(true,h.cx);
  assert.equal(toggles.at(-1)[1].terminal,'t1');assert.equal(toggles.at(-1)[0],field);
 }
 assert.equal(overlays.length,0);
 const text=nodes.flatMap(n=>n.children??[]).filter(x=>typeof x==='string').join(' ');
 assert.ok(!text.includes('Last request'));assert.ok(!text.includes('Session processed'));assert.ok(!text.includes('Token usage unavailable'));
 nodes.length=0;toggles.length=0;h.instance.session={};h.instance.current.terminal='t1';
 h.instance.sessionContent({});
 for(const field of ['model','effort','mode','permissions']){
  nodes.find(n=>n.id===`session-dropdown-${field}`).toggle(true,h.cx);
  assert.equal(toggles.at(-1)[2],undefined);
 }
});
function displayHarness(h) {
 const nodes=[];
 const element=()=>{
  const node={children:[]};nodes.push(node);let proxy;
  proxy=new Proxy(node,{get(_t,key){
   if(key==='__node')return node;
   if(key==='when')return (condition,fn)=>condition?fn(proxy):proxy;
   if(key==='id')return value=>{node.id=value;return proxy;};
   if(key==='on_click')return value=>{node.click=value;return proxy;};
   if(key==='child')return value=>{node.children.push(value?.__node??value);return proxy;};
   if(key==='children')return values=>{for(const value of values)node.children.push(value?.__node??value);return proxy;};
   return ()=>proxy;
  }});return proxy;
 };
 h.scope.div=h.scope.h_flex=h.scope.v_flex=h.scope.svg=element;
 h.scope.Progress=h.scope.ProgressTrack=h.scope.ProgressIndicator={new:element};
 h.scope.Popover={new:id=>element().id(id)};
 h.scope.Popup={new:(id,trigger)=>element().id(id).child(trigger)};
 const text=node=>typeof node==='string'?[node]:(node?.children??[]).flatMap(text);
 return {nodes,text,element};
}
test('session identity is first and the copy icon copies the displayed raw ID',()=>{
 const h=harness(),ui=displayHarness(h),copied=[];
 h.instance.current={agent:'codex',terminal:'t1',sessionTitle:'My session | project | weekly 80% left'};
 h.instance.session={session:'displayed-id',model:'example',effort:'high',contextPercent:75,contextWindow:475000};
 const root=h.instance.sessionContent({}).__node;
 assert.equal(root.children[0].id,'session-title');assert.equal(ui.text(root.children[0]).join(''),'My session');
 assert.equal(root.children[1].children[0].id,'session-id');
 assert.equal(ui.text(root.children[1].children[0]).join(''),'displayed-id');
 h.instance.session={session:'new-id'};
 ui.nodes.find(n=>n.id==='copy-session-id').click({}, {...h.cx,stop_propagation(){},write_to_clipboard:value=>copied.push(value)});
 assert.deepEqual(copied,['displayed-id']);
 assert.ok(!ui.text(root).includes('Session displayed-id'));assert.ok(!ui.text(root).includes('Context window'));
 const ratio=ui.nodes.find(n=>n.id==='context-token-ratio');
 assert.equal(ui.text(ratio).join(''),'356k/475k');
 const usage=root.children.find(n=>n?.children?.includes(ratio));
 assert.ok(ui.text(usage).includes('75% used'),'percentage and compact tokens share one row');
});
test('copy feedback appears immediately, expires, and older timers cannot clear a repeated copy',()=>{
 const h=harness(),ui=displayHarness(h),copied=[];
 h.instance.current={};h.instance.session={session:'sid'};
 const cx={...h.cx,stop_propagation(){},write_to_clipboard:value=>copied.push(value)};
 const render=()=>{ui.nodes.length=0;h.instance.sessionContent({});};
 render();assert.ok(!ui.nodes.some(n=>n.id==='session-copy-confirmation'));
 ui.nodes.find(n=>n.id==='copy-session-id').click({},cx);render();
 assert.equal(ui.text(ui.nodes.find(n=>n.id==='session-copy-confirmation')).join(''),'coppied');
 assert.equal(h.delays[0].ms,1600);
 ui.nodes.find(n=>n.id==='copy-session-id').click({},cx);
 const notices=h.state.notices;h.delays[0].fn(h.cx);
 assert.equal(h.instance.copiedSession,'sid');assert.equal(h.state.notices,notices);
 h.delays[1].fn(h.cx);render();assert.ok(!ui.nodes.some(n=>n.id==='session-copy-confirmation'));
 assert.deepEqual(copied,['sid','sid']);
 h.instance.copySession('sid',cx);h.instance.session={session:'other'};render();
 assert.ok(!ui.nodes.some(n=>n.id==='session-copy-confirmation'),'feedback is scoped to the copied ID');
 h.instance.close();const closedNotices=h.state.notices;h.delays[2].fn(h.cx);assert.equal(h.state.notices,closedNotices);
});
test('context token ratios use compact units and do not fabricate missing metrics',()=>{
 const h=harness(),ui=displayHarness(h);h.instance.current={};
 for(const [percent,window,expected] of [[30,1000000,'300k/1M'],[63.1578947368,475000,'300k/475k'],[0,475000,'0/475k'],[140,475000,'475k/475k'],[75,null,null],[null,475000,null],[75,-1,null]]){
  ui.nodes.length=0;h.instance.session={contextPercent:percent,contextWindow:window};h.instance.sessionContent({});
  const ratio=ui.nodes.find(n=>n.id==='context-token-ratio');
  assert.equal(ratio?ui.text(ratio).join(''):null,expected);
 }
});
test('major sections collapse independently and retain their state through polling and focus changes',async()=>{
 const h=harness();h.instance.init({},h.cx);h.pending[0](null);await h.settle();
 const ui=displayHarness(h);let closed=0;
 h.instance.sessionContent=()=>ui.element().child('session-body');
 h.instance.accountContent=()=>ui.element().child('account-body');
 h.instance.mcpContent=()=>ui.element().child('mcp-body');
 h.instance.sessionControl={close(){closed++;}};
 for(const key of ['session','account','mcp']){
  ui.nodes.length=0;h.instance.render();ui.nodes.find(n=>n.id===`section-${key}`).click({},h.cx);
  const text=ui.text(h.instance.render().__node);assert.ok(!text.includes(`${key}-body`));
  assert.ok(ui.nodes.some(n=>n.id===`section-${key}`));
 }
 assert.equal(closed,1);assert.equal(h.instance.sessionControl,null);
 h.poll();h.pending[1](null);await h.settle();
 h.state.focus.terminal='t2';h.state.pane.terminal='t2';h.instance.refresh(h.cx,false);
 for(const key of ['session','account','mcp'])assert.equal(h.instance.collapsed[key],true);
 for(const key of ['session','account','mcp']){
  ui.nodes.length=0;h.instance.render();ui.nodes.find(n=>n.id===`section-${key}`).click({},h.cx);
  assert.ok(ui.text(h.instance.render().__node).includes(`${key}-body`));
 }
});
test('usage bars clamp widths and omit unavailable values', () => {
 const bars=[];
 const element=()=>new Proxy({}, {get(_t,key) {
   if(key==='when') return (condition,fn)=>condition?fn(element()):element();
   if(key==='child')return ()=>element(); if(key==='children')return ()=>element();
   if(key==='w')return value=>{bars.push(value);return element();};
   if(key==='value')return value=>{bars.push(value);return element();};
   return ()=>element();
 }});
 const component={new:()=>element()};
 const scope={View:class{},div:element,h_flex:element,v_flex:element,Progress:component,ProgressTrack:component,ProgressIndicator:component,permissionLabel:id=>id??'Unavailable',theme:()=>({}),focused:()=>null,spaces:()=>[],panes:()=>[]};
 vm.runInNewContext(source,scope);const view=new scope.Inspector();
 view.current={agent:'codex'};view.entries=[];view.quota=[{minutes:300,used:140},{minutes:10080,used:null}];view.render();
 assert.deepEqual(bars,[100,'100%']);
});

test('quota labels show remaining reset time and handle missing or expired timestamps',()=>{
 const h=harness(),ui=displayHarness(h),now=h.state.time;
 h.instance.current={agent:'codex'};
 h.instance.quota=[{minutes:300,used:12,reset:(now+10*60000)/1000},{minutes:10080,used:34,reset:(now+(2*1440+3*60)*60000)/1000}];
 let text=ui.text(h.instance.accountContent({}).__node);
 assert.ok(text.includes('5h (10m)'));assert.ok(text.includes('7d (2d 3h)'));
 h.instance.quota=[{minutes:300,reset:(now+60*60000+1)/1000},{minutes:10080,reset:(now-1)/1000}];
 text=ui.text(h.instance.accountContent({}).__node);
 assert.ok(text.includes('5h (1h 1m)'));assert.ok(text.includes('7d (0m)'));
 for(const reset of [undefined,null,0,-1,NaN,Infinity,1e20]){
  h.instance.quota=[{minutes:300,reset}];text=ui.text(h.instance.accountContent({}).__node);
  assert.ok(text.includes('5h'));assert.ok(text.includes('7d'));
 }
});

test('Claude terminals read the bridge session, take quota from it and never start the Codex quota job',async()=>{
 const h=harness(),execs=[],reads=[];
 h.scope.exec=async(cmd,args)=>{execs.push({cmd,args});return {code:1,stdout:''};};
 h.scope.readSession=async current=>{reads.push(current.agent);return {session:'sid',quota:[{minutes:300,used:14,reset:1794556800}]};};
 h.instance.init({},h.cx);h.pending[0](null);await h.settle();
 assert.deepEqual(reads,['claude-code']);assert.equal(h.instance.session.session,'sid');
 assert.equal(h.instance.quota[0].used,14);
 assert.ok(!execs.some(call=>call.cmd==='python'&&String(call.args?.[1]).includes('rateLimits')),'no Codex quota job');
 const ui=displayHarness(h);h.instance.current={agent:'claude-code'};
 assert.ok(ui.text(h.instance.accountContent({}).__node).includes('Claude account for this session.'));
 h.state.pane.app='opencode';h.instance.refresh(h.cx);h.pending[1](null);await h.settle();assert.deepEqual(reads,['claude-code']);
});
test('an animated Claude title keeps the session cache and open picker',async()=>{
 const h=harness();let reads=0;h.state.pane.title='✳ Topic';
 h.scope.readSession=async()=>{reads++;return {session:'sid'};};
 h.instance.init({},h.cx);h.pending[0](null);await h.settle();
 const picker={close(){picker.closed=true;},current:{...h.instance.current,session:'sid'}};h.instance.sessionControl=picker;
 h.state.pane.title='· Topic';h.instance.refresh(h.cx,false);await h.settle();
 assert.equal(reads,1);assert.equal(h.instance.session.session,'sid');assert.ok(!picker.closed);
});
test('a Claude terminal without the bridge mod shows only the install hint',()=>{
 const h=harness(),ui=displayHarness(h);
 h.instance.current={agent:'claude-code',terminal:'t1',cwd:'C:/p',sessionTitle:'Claude'};h.instance.session={bridgeMissing:true};
 const text=ui.text(h.instance.sessionContent({}).__node).join(' ');
 assert.ok(text.includes('Install the herdr-bridge Claude mod to see session details.'));
 assert.ok(!text.includes('Model'));assert.ok(!ui.nodes.some(n=>String(n.id).startsWith('session-dropdown')));
});
test('Claude rows offer only Model and Effort dropdowns, show permission mode and reported tokens',()=>{
 const h=harness(),ui=displayHarness(h);
 h.instance.current={agent:'claude-code',terminal:'t1',cwd:'C:/p',sessionTitle:'Claude'};
 h.instance.session={session:'sid',model:'claude-opus-5-5',effort:'high',permission:'acceptEdits',contextPercent:11,contextWindow:1000000,contextTokens:113000,
  choices:{model:['opus','sonnet'],effort:['low','high']}};
 let text=ui.text(h.instance.sessionContent({}).__node);
 assert.deepEqual(ui.nodes.filter(n=>String(n.id).startsWith('session-dropdown')).map(n=>n.id),['session-dropdown-model','session-dropdown-effort']);
 assert.ok(text.includes('Permission mode'));assert.ok(text.includes('Accept edits'));assert.ok(!text.includes('Permissions'));
 assert.equal(ui.text(ui.nodes.find(n=>n.id==='context-token-ratio')).join(''),'113k/1M');
 ui.nodes.length=0;h.instance.session={session:'sid',choices:{model:[],effort:[]}};text=ui.text(h.instance.sessionContent({}).__node);
 assert.equal(ui.nodes.filter(n=>String(n.id).startsWith('session-dropdown')).length,0,'no choices means read-only rows');
 assert.ok(text.includes('Unavailable'));
});
test('quota countdown updates with the clock even if the provider snapshot stays unchanged',async()=>{
 const h=harness();h.instance.init({},h.cx);h.pending[0](null);await h.settle();
 const sync=h.instance.sync.bind(h.instance);
 h.instance.sync=(...args)=>{sync(...args);h.instance.quota=[{minutes:300,reset:700}];};
 h.timers[0].fn(h.cx);const notices=h.state.notices;
 h.state.time+=60000;h.timers[0].fn(h.cx);assert.equal(h.state.notices,notices+1);
 h.timers[0].fn(h.cx);assert.equal(h.state.notices,notices+1);
});
