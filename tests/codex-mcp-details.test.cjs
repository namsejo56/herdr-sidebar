const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync('mods/context-inspector-261109/mcp-details.js', 'utf8');
const backend = fs.readFileSync('mods/context-inspector-261109/mcp-connection.js', 'utf8');
const probe = backend.slice(backend.indexOf('function codexProbe()'), backend.indexOf('\nconst TTL'));

function runProbe(respond, options = {}) {
  return new Promise(resolve => {
    const child = new EventEmitter(); child.pid = 123; child.stdout = new EventEmitter(); child.stdin = new EventEmitter();
    const lines = new EventEmitter(); const calls = []; let killed = false;
    child.stdin.write = input => {
      const request = JSON.parse(input); calls.push(request);
      if (request.id !== undefined) setImmediate(() => {
        const response = respond(request);
        if (response !== undefined) lines.emit('line', typeof response === 'string' ? response : JSON.stringify(response));
      });
    };
    const fakeProcess = { argv: ['node', 'wanted'], platform: 'linux', stdout: { write: (output, callback) => { resolve({ output: JSON.parse(output), calls, killed }); if (callback) callback(); } }, exit() {}, kill(pid) { assert.equal(pid, -123); killed = true; } };
    const context = { process: fakeProcess, require(name) {
      if (name === 'child_process') return { spawn: () => child, spawnSync() { throw Error('unexpected'); } };
      if (name === 'readline') return { createInterface: () => lines };
      throw Error(name);
    }, setTimeout: options.timeout ? fn => { setImmediate(fn); return 1; } : setTimeout, clearTimeout };
    vm.runInNewContext(probe + '\ncodexProbe()', context);
  });
}
const init = request => request.id === 1 ? { id: 1, result: {} } : null;

test('successful initialization with an empty tool inventory establishes the separate connection', async () => {
  const {output}=await runProbe(r=>init(r)||{id:r.id,result:{data:[{name:'wanted',runtimeStatus:null,authStatus:'unsupported',serverInfo:{name:'test',version:'1'},tools:{},toolsError:null}],nextCursor:null}});
  assert.equal(output.status,'connected');assert.deepEqual(output.tools,[]);
});

test('tool inventory alone is not live connection evidence and discovery failure overrides initialization', async()=>{
  for(const [extra,expected] of [[{},null],[{serverInfo:{name:'test'},toolsError:'sensitive error'},'failed'],[{serverCapabilities:{},authStatus:'notLoggedIn'},'authenticationRequired']]){
    const {output}=await runProbe(r=>init(r)||{id:r.id,result:{data:[{name:'wanted',runtimeStatus:null,authStatus:'unknown',tools:{cached:{name:'cached'}},...extra}],nextCursor:null}});
    assert.equal(output.status,expected);assert.ok(!JSON.stringify(output).includes('sensitive error'));
  }
});

test('filters exact server, follows cursor, sanitizes descriptions and kills process', async () => {
  const { output, calls, killed } = await runProbe(r => init(r) || (r.params.cursor ?
    { id: r.id, result: { data: [{ name: 'wanted', runtimeStatus: 'connected', authStatus: 'oAuth', tools: {
      one: { name: 'search', description: 'Search the catalog' }, two: { name: 'private', description: 'Use https://example.test/?token=secret' }
    } }], nextCursor: null } } :
    { id: r.id, result: { data: [{ name: 'other', tools: {} }], nextCursor: 'next' } }));
  assert.equal(output.status, 'connected'); assert.equal(output.tools[0].description, 'Search the catalog');
  assert.equal(output.tools[1].description, '[Description withheld]'); assert.equal(killed, true);
  const lists = calls.filter(c => c.method === 'mcpServerStatus/list');
  assert.equal(lists.length, 2); assert.ok(lists.every(c => c.params.serverName === 'wanted')); assert.equal(lists[1].params.cursor, 'next');
});

test('reports unsupported method and timeout without exposing errors', async () => {
  const failure = await runProbe(r => init(r) || { id: r.id, error: { message: 'sensitive text' } });
  assert.equal(failure.output.error, 'Discovery unsupported or failed'); assert.equal(failure.killed, true);
  const timeout = await runProbe(() => undefined, { timeout: true });
  assert.equal(timeout.output.error, 'Timed out'); assert.equal(timeout.killed, true);
});

test('reports repeated pagination cursor and absent server', async () => {
  const loop = await runProbe(r => init(r) || { id: r.id, result: { data: [], nextCursor: 'same' } });
  assert.equal(loop.output.error, 'Invalid pagination');
  const absent = await runProbe(r => init(r) || { id: r.id, result: { data: [], nextCursor: null } });
  assert.equal(absent.output.error, 'Server not found');
});
test('details render discovered tool names and descriptions', () => {
 const displayed=[];
 const builder=()=>new Proxy({}, {get(_t,key) {if (key==='child') return v=>{if(typeof v==='string')displayed.push(v);return builder();}; if(key==='children')return ()=>builder(); if(key==='when')return (condition,fn)=>condition?fn(builder()):builder(); return ()=>builder();}});
 const mod=source.replace(/^\uFEFF/, '').replace(/^import .*;\r?\n/gm,'').replace('export default class McpDetails','class McpDetails')+'\nthis.McpDetails=McpDetails;';
 const scope={View:class{},props:()=>({}),focused:()=>null,theme:()=>({}),div:builder,v_flex:builder,h_flex:builder};vm.runInNewContext(mod,scope);
 const view=new scope.McpDetails();Object.assign(view,{name:'sample',check:{result:{tools:[{name:'search',description:'Search docs'}],health:'Connected'}}});view.render();
 assert.ok(displayed.includes('search'));assert.ok(displayed.includes('Search docs'));
});
test('closing details prevents notifications from an outstanding discovery', async () => {
 let resolveProbe; let notices=0;
 const mod=source.replace(/^\uFEFF/, '').replace(/^import .*;\r?\n/gm,'').replace('export default class McpDetails','class McpDetails')+'\nthis.McpDetails=McpDetails;';
 const entry={job:new Promise(r=>{resolveProbe=r;})};
 const scope={View:class{},focused:()=>null,connection:()=>entry,connectionVersion:()=>null};
 vm.runInNewContext(mod,scope);
 let job; const view=new scope.McpDetails();view.init({server:'wanted',cwd:'C:/x',agent:'codex'}, {spawn:fn=>{job=fn({notify(){notices++;}});},timer:{every(){}}});
 view.close(); resolveProbe({code:0,stdout:JSON.stringify({status:'connected',tools:[]})});
 await job; assert.equal(notices,0);
});
test('details hide old server tools after focus changes', () => {
 const displayed=[];
 const builder=()=>new Proxy({}, {get(_t,key) {if(key==='child')return v=>{if(typeof v==='string')displayed.push(v);return builder();}; if(key==='children')return ()=>builder();if(key==='when')return (c,fn)=>c?fn(builder()):builder();return ()=>builder();}});
 const mod=source.replace(/^\uFEFF/, '').replace(/^import .*;\r?\n/gm,'').replace('export default class McpDetails','class McpDetails')+'\nthis.McpDetails=McpDetails;';
 const scope={View:class{},props:()=>({}),focused:()=>({terminal:'other'}),theme:()=>({}),div:builder,v_flex:builder,h_flex:builder};vm.runInNewContext(mod,scope);
 const view=new scope.McpDetails();Object.assign(view,{name:'old',terminal:'original',tools:[{name:'old-tool'}]});view.render();
 assert.ok(displayed.includes('Terminal changed')); assert.ok(!displayed.includes('old-tool'));
});

test('legacy details mod redirects to Context without reusing the old overlay id',()=>{
 const redirects=[],closed=[];
 const legacy=fs.readFileSync('mods/mcp-details-261109/main.js','utf8').replace(/^import .*;\r?\n/gm,'')
   .replace('export default class McpDetails','class LegacyDetails')+'\nthis.LegacyDetails=LegacyDetails;';
 const scope={View:class{},props:()=>({server:'wanted',cwd:'C:/p',terminal:'t1',overlay:'old'}),openOverlay:p=>redirects.push(p),closeOverlay:id=>closed.push(id)};
 vm.runInNewContext(legacy,scope);new scope.LegacyDetails().init();
 assert.equal(redirects[0].mod,'context-inspector-261109');assert.equal(redirects[0].props.server,'wanted');
 assert.equal(redirects[0].props.overlay,undefined);assert.deepEqual(closed,['old']);
});
