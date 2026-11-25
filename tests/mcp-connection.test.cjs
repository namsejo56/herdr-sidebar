const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('mods/context-inspector-261109/mcp-connection.js', 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/export function /g, 'function ');
const current = {space:'space',machine:null,cwd:'C:/project',agent:'codex',terminal:'one'};
function harness(run = async()=>({code:0,stdout:'{"status":"connected","tools":[]}'})) {
  const state={time:100000,calls:[]};
  const scope={Date:class extends Date{static now(){return state.time;}},exec:async(...args)=>{state.calls.push(args);return run(...args);}};
  vm.runInNewContext(source,scope);return {scope,state};
}
test('list and details coalesce work and terminal switches reuse the same result',async()=>{
  const h=harness();const first=h.scope.connection(current,'server','v1');
  const second=h.scope.connection({...current,terminal:'two'},'server','v1');
  assert.equal(first,second);assert.equal(first.job,second.job);await first.job;
  assert.equal(first.result.health,'Connected');assert.equal(h.state.calls.length,1);
  assert.equal(h.scope.connection(current,'server','v1'),first);assert.equal(first.job,null);
});
test('connection checks are serialized and queued results remain isolated',async()=>{
  const waiting=[];const h=harness(()=>new Promise(resolve=>waiting.push(resolve)));
  const first=h.scope.connection(current,'first','v1'),second=h.scope.connection(current,'second','v1');
  await new Promise(setImmediate);assert.equal(h.state.calls.length,1);
  waiting[0]({code:0,stdout:'{"status":"failed","tools":[]}'});await first.job;
  await new Promise(setImmediate);assert.equal(h.state.calls.length,2);
  waiting[1]({code:0,stdout:'{"status":"connected","tools":[]}'});await second.job;
  assert.equal(first.result.health,'Connection failed');assert.equal(second.result.health,'Connected');
});
test('configuration changes, spaces, machines and agent types cannot reuse another result',async()=>{
  const h=harness();const first=h.scope.connection(current,'server','v1');await first.job;
  for(const [context,version] of [[current,'v2'],[{...current,space:'other'},'v1'],[{...current,machine:'remote'},'v1'],[{...current,cwd:'C:/other'},'v1'],[{...current,agent:'shell'},'v1']]){
    const next=h.scope.connection(context,'server',version);assert.notEqual(next,first);await next.job;
  }
  assert.equal(h.state.calls[3][2].on,'remote');
});
test('expiry and explicit refresh rerun checks without losing the entry',async()=>{
  const h=harness();const entry=h.scope.connection(current,'server','v1');await entry.job;
  h.state.time+=59999;assert.equal(h.scope.connection(current,'server','v1').job,null);
  h.state.time++;assert.equal(h.scope.connection(current,'server','v1'),entry);await entry.job;
  const refreshed=h.scope.connection(current,'server','v1',true);await refreshed.job;assert.equal(h.state.calls.length,3);
});
test('errors, auth, failed discovery and unknown inventory never become connected',async()=>{
  const results=[{error:'unsupported'},{auth:'notLoggedIn',status:'connected'},{discoveryFailed:true,status:'connected'},
    {status:null,tools:[{name:'cached'}]}];
  const h=harness(async()=>({code:0,stdout:JSON.stringify(results.shift())}));
  for(const [i,health] of ['Check failed','Needs authentication','Connection failed','Unknown'].entries()){
    const entry=h.scope.connection(current,'server',`v${i}`);await entry.job;assert.equal(entry.result.health,health);
  }
});
test('missing executable and invalid JSON return a safe failed check',async()=>{
  let mode='throw';const h=harness(async()=>{if(mode==='throw')throw Error('private value');return {code:0,stdout:'not-json'};});
  const one=h.scope.connection(current,'server','v1');await one.job;assert.equal(one.result.health,'Check failed');
  mode='invalid';const two=h.scope.connection(current,'server','v2');await two.job;
  assert.equal(two.result.health,'Check failed');assert.ok(!JSON.stringify(two.result).includes('private value'));
});
test('Claude parses explicit status safely and does not treat a failed command as connected',async()=>{
  const responses=[{code:0,stdout:'Status: Connected'},{code:0,stdout:'Status: Not connected'},
    {code:0,stdout:'Status: Needs authentication'},{code:1,stdout:'Status: Connected'},
    {code:0,stdout:'Status: Pending approval'},{code:0,stdout:'Status: Disabled'}];
  const h=harness(async()=>responses.shift());
  for(const [i,health] of ['Connected','Connection failed','Needs authentication','Connection failed','Pending approval','Disabled'].entries()){
    const entry=h.scope.connection({...current,agent:'claude-code'},'server',`v${i}`);await entry.job;assert.equal(entry.result.health,health);
  }
  assert.ok(h.state.calls.every(([cmd,args])=>cmd==='claude'&&args.join(' ')==='mcp get server'));
});
test('configuration version registry isolates scopes and updates the source for an open details view',()=>{
  const h=harness();h.scope.setConnectionVersion(current,'before');assert.equal(h.scope.connectionVersion(current),'before');
  h.scope.setConnectionVersion(current,'after');assert.equal(h.scope.connectionVersion({...current,terminal:'two'}),'after');
  assert.equal(h.scope.connectionVersion({...current,space:'other'}),undefined);
});

test('queued work does not start for closed or inactive views',async()=>{
  let release;const h=harness(()=>new Promise(resolve=>{release=resolve;}));
  const first=h.scope.connection(current,'running','v1');
  const owner={closed:false,active(){return !this.closed;}};
  const queued=h.scope.connection(current,'queued','v1',false,owner);
  await new Promise(setImmediate);owner.closed=true;
  release({code:0,stdout:'{"status":"connected","tools":[]}'});await first.job;await queued.job;
  assert.equal(h.state.calls.length,1);assert.equal(queued.result,null);
});
