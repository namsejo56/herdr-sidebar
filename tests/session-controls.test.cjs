const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../mods/context-inspector-261109/session-controls.js'), 'utf8')
 .replace(/^import .*;\r?\n/gm,'').replace('export default class SessionControls','class SessionControls')+'\nthis.SessionControls=SessionControls;';
function harness() {
 const jobs=[],calls=[],nodes=[];
 const element=()=>{
  const node={};nodes.push(node);let el;
  el=new Proxy(node,{get(_t,key){
   if(key==='when')return (condition,fn)=>condition?fn(el):el;
   if(key==='id')return value=>{node.id=value;return el;};
   if(key==='on_click')return value=>{node.click=value;return el;};
   if(key==='w'||key==='h'||key==='max_h')return value=>{node[key]=value;return el;};
   return ()=>el;
  }});return el;
 };
 const current={space:'s',terminal:'t1',cwd:'C:/project',agent:'codex',session:'sid',control:'effort'};
 const state={model:'gpt-example',effort:'high',mode:'default'};
 const scope={div:element,v_flex:element,theme:()=>({}),focused:()=>current,terminals:()=>[{address:'t1',title:'session'}],
  controlSession:async(...args)=>{calls.push(args);return {state,choices:[{id:'gpt-example',name:'Example',efforts:['low','high']}]};},
  readSession:async()=>({session:'sid'}),permissionLabel:id=>id,cachedSessionOptions:()=>null};
 vm.runInNewContext(source,scope);
 const cx={spawn:fn=>jobs.push(fn(cx)),notify(){}};
 const instance=new scope.SessionControls();instance.init(current,cx,()=>calls.push({dismiss:true}));
 return {instance,current,state,jobs,calls,scope,cx,nodes,async settle(){for(let i=0;i<jobs.length;i++)await jobs[i];}};
}
test('picker updates only its captured session after a fresh identity check',async()=>{
 const h=harness();await h.settle();h.instance.save('low',h.cx);await h.settle();
 assert.equal(h.calls[1][1],'sid');assert.equal(h.calls[1][2],'update');assert.equal(h.calls[1][3],'effort');
 assert.equal(h.calls[1][4],'low');assert.equal(h.calls[1][5].model,h.state.model);
 assert.equal(h.calls.at(-1).dismiss,true);
});
test('focus changes, a different session and closed views cannot apply changes',async()=>{
 for(const change of [h=>{h.current.terminal='t2';},h=>{h.scope.readSession=async()=>({session:'other'});},h=>h.instance.close()]){
  const h=harness();await h.settle();change(h);h.instance.save('low',h.cx);await h.settle();
  assert.equal(h.calls.filter(args=>args[2]==='update').length,0);
 }
});
test('rejected updates keep the picker open with an error',async()=>{
 const h=harness();await h.settle();h.scope.controlSession=async()=>{throw new Error('settings changed');};
 h.instance.save('low',h.cx);await h.settle();
 assert.equal(h.instance.error,'settings changed');assert.equal(h.instance.busy,false);
 assert.ok(!h.calls.some(call=>call.dismiss));
});
test('model and effort choices stay in one compact dropdown until a verified save',async()=>{
 const h=harness();await h.settle();h.instance.field='model';h.instance.render();
 assert.ok(h.nodes.some(n=>n.w===280&&n.max_h===360));
 assert.ok(h.nodes.some(n=>n.h>0&&n.h<=270),'the native scroll list needs an explicit nonzero height');
 h.nodes.find(n=>n.id==='model-gpt-example').click({},h.cx);
 assert.equal(h.calls.length,1,'choosing a model does not apply or dismiss before effort is chosen');
 h.nodes.length=0;h.instance.render();
 h.nodes.find(n=>n.id==='effort-low').click({},h.cx);await h.settle();
 assert.equal(h.calls[1][4].model,'gpt-example');assert.equal(h.calls[1][4].effort,'low');assert.equal(h.calls.at(-1).dismiss,true);
});
test('permissions and approval policy stay in the same dropdown and support Back',async()=>{
 const h=harness();await h.settle();h.instance.field='permissions';
 h.instance.choices=[{id:':workspace',name:'Workspace'}];h.instance.render();
 h.nodes.find(n=>n.id==='permission-:workspace').click({},h.cx);
 assert.equal(h.calls.length,1);h.nodes.length=0;h.instance.render();
 h.nodes.find(n=>n.id==='controls-back').click({},h.cx);assert.equal(h.instance.selectedPermission,null);
 h.instance.selectedPermission={id:':workspace',name:'Workspace'};h.nodes.length=0;h.instance.render();
 h.nodes.find(n=>n.id==='approval-on-request').click({},h.cx);await h.settle();
 assert.equal(h.calls[1][4].permission,':workspace');assert.equal(h.calls[1][4].approvalPolicy,'on-request');
});
test('a cached dropdown opens synchronously without a loading state or another request',async()=>{
 const h=harness();await h.settle();const jobs=h.jobs.length,calls=h.calls.length;
 h.scope.cachedSessionOptions=()=>({state:h.state,choices:[{id:'cached'}]});
 const next=new h.scope.SessionControls();next.init(h.current,h.cx,()=>{});
 assert.equal(next.loading,false);assert.equal(next.choices[0].id,'cached');
 assert.equal(h.jobs.length,jobs);assert.equal(h.calls.length,calls);
});

test('a new-session picker browses model and effort catalogs but cannot issue an unidentified write',async()=>{
 const h=harness();await h.settle();
 h.scope.controlSession=async(...args)=>{h.calls.push(args);return {choices:[{id:'example',name:'Example',efforts:['low','high']}]};};
 const picker=new h.scope.SessionControls();
 picker.init({...h.current,session:null,state:{},control:'effort'},h.cx,()=>{});await h.settle();
 picker.render();h.nodes.find(n=>n.id==='model-example').click({},h.cx);
 h.nodes.length=0;picker.render();
 assert.equal(picker.field,'effort','the dropdown must stay anchored to its original row');
 h.nodes.find(n=>n.id==='effort-low').click({},h.cx);await h.settle();
 assert.match(picker.error,/Session not identified/);
 assert.equal(h.calls.filter(args=>args[2]==='update').length,0);
});
test('Claude pickers show flat Model and Effort lists and apply one value directly',async()=>{
 for(const [field,id] of [['model','sonnet'],['effort','low']]){
  const h=harness();await h.settle();
  const claude={...h.current,agent:'claude-code',control:field,state:{session:'sid',model:'claude-opus-5-5',effort:'high'}};
  h.scope.controlSession=async(...args)=>{h.calls.push(args);
   return args[2]==='options'?{choices:field==='model'?[{id:'opus',name:'opus'},{id:'sonnet',name:'sonnet'}]:[{id:'low',name:'low'},{id:'high',name:'high'}]}:{verified:true};};
  const picker=new h.scope.SessionControls();picker.init(claude,h.cx,()=>h.calls.push({dismiss:true}));await h.settle();
  h.nodes.length=0;picker.render();
  assert.ok(!h.nodes.some(n=>String(n.id).startsWith(field==='model'?'effort-':'model-')),'no per-model nesting for Claude');
  h.nodes.find(n=>n.id===`${field}-${id}`).click({},h.cx);await h.settle();
  const update=h.calls.find(args=>args[2]==='update');
  assert.equal(update[3],field);assert.equal(update[4],id);assert.equal(h.calls.at(-1).dismiss,true);
 }
});
