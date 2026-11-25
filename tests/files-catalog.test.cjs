const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { harness } = require('./files-harness.cjs');
const execute = promisify(execFile);
const catalogFile = path.join(__dirname, '../mods/claude-files-261106/files-catalog.js');
const directoryFile = path.join(__dirname, '../mods/claude-files-261106/files-directory.js');
const dir = name => ({ name, dir: true });
const file = name => ({ name, dir: false });

function world(tree = {}, options = {}) {
  const batches = [], statuses = [], readers = [], commands = [];
  const h = harness({ ...options, props: { catalogService: true }, onShared: (key, value) => statuses.push({ key, value }),
    watchFolder: options.keepWatch ? () => new Promise(resolve => readers.push(resolve)) : undefined,
    exec: options.exec || (async (command, args, opts) => {
      commands.push({ command, args, opts });
      if (command === 'git') return { code: 1, stdout: '' };
      let request;
      try { request = JSON.parse(args.at(-1)); } catch { /* Single-folder fallback. */ }
      if (Array.isArray(request)) {
        batches.push(request.map(item => item.path));
        if (options.beforeBatch) await options.beforeBatch(request);
        const results = await Promise.all(request.map(async item => {
          const full = item.full.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
          const value = typeof tree[full] === 'function' ? await tree[full](item) : tree[full] ?? [];
          return value instanceof Error ? { path: item.path, error: String(value) }
            : { path: item.path, ...(Array.isArray(value) ? { items: value, real: full } : value) };
        }));
        return { code: 0, stdout: JSON.stringify(results), stderr: '' };
      }
      const value = tree[args.at(-1).replace(/\\/g, '/').replace(/\/+$/, '')] || [];
      return { code: 0, stdout: opts?.on ? value.map(item => `${item.dir ? 'd' : 'f'}\0${item.name}\0`).join('') : JSON.stringify(value), stderr: '' };
    }) });
  const api = h.loadModule(catalogFile);
  const watch = api.FilesCatalog.prototype.watch;
  if (!options.keepWatch) api.FilesCatalog.prototype.watch = () => {};
  h.view.init({}, h.cx);
  const owner = h.view.catalog;
  function view() { h.state.props = {}; const result = new h.scope.Files(); result.init({}, h.cx); return result; }
  async function drain() { owner.sync(h.cx); await h.drain(); }
  return { h, owner, api, tree, batches, statuses, readers, commands, view, drain, watch };
}

test('service warms the tree before a Files view exists and batches child directories', async () => {
  const w = world({ 'C:/project': [dir('a'), dir('b'), dir('c')], 'C:/project/a': [file('a.txt')] });
  await w.drain();
  assert.equal(w.h.view.catalogService, true); assert.equal(w.h.view.query, undefined);
  assert.deepEqual(w.batches.map(batch => Array.from(batch)), [[''], ['a', 'b', 'c']]);
  assert.equal(w.owner.active.cache.get('a').items[0].name, 'a.txt');
  assert.equal(w.statuses.at(-1).value.ready, true);
  assert.ok(w.statuses.every(entry => entry.key === 'files.catalog.status.v1'));
});

test('a prefetched folder opens in independent Files copies without a directory process', async () => {
  const w = world({ 'C:/project': [dir('a')], 'C:/project/a': [file('ready.txt')] }); await w.drain();
  const first = w.view(), second = w.view(); await w.drain(); const before = w.batches.length;
  first.toggle('a', w.h.cx); second.toggle('a', w.h.cx); await w.drain();
  assert.equal(w.batches.length, before);
  assert.equal(first.entries.get('a')[0].name, 'ready.txt'); assert.equal(second.entries.get('a')[0].name, 'ready.txt');
  assert.notEqual(first.entries.get('a'), second.entries.get('a'));
});

test('an idle service does not spawn an asynchronous task on each render', async () => {
  const w = world(); await w.drain();
  assert.equal(w.h.jobs.length, 0);
  for (let i = 0; i < 20; i++) w.owner.sync(w.h.cx);
  assert.equal(w.h.jobs.length, 0);
});

test('polling recovers a failed initial scan and resumes child warmup', async () => {
  let now = 0;
  const w = world({ 'C:/project': new Error('temporarily unavailable') }, { Date: { now: () => now } }); await w.drain();
  assert.equal(w.statuses.at(-1).value.ready, false);
  w.tree['C:/project'] = [dir('recovered')]; w.tree['C:/project/recovered'] = [file('ready.txt')]; now = 20000;
  w.owner.poll(w.h.cx); await w.drain();
  assert.equal(w.owner.active.cache.get('recovered').items[0].name, 'ready.txt');
  assert.equal(w.statuses.at(-1).value.ready, true);
});

test('space switches retain warm cache and return without another directory read', async () => {
  const w = world({ 'C:/project': [dir('a')], 'C:/project/a': [file('one.txt')], 'C:/second': [file('two.txt')] });
  await w.drain(); const view = w.view(); await w.drain(); view.toggle('a', w.h.cx); await w.drain();
  w.h.state.space = 'second'; w.h.state.cwd = 'C:/second'; w.owner.sync(w.h.cx); view.refresh(w.h.cx); await w.drain();
  const before = w.batches.length;
  w.h.state.space = 's'; w.h.state.cwd = 'C:/project'; w.owner.sync(w.h.cx); view.refresh(w.h.cx); await w.drain();
  assert.equal(w.batches.length, before); assert.equal(w.owner.roots.size, 2);
  assert.equal(view.entries.get('a')[0].name, 'one.txt');
});

test('catalog keys isolate space, machine and root and normalize local Windows casing', async () => {
  const w = world(); await w.drain();
  const base = { cwd: 'C:/project', on: null, space: 's' };
  assert.equal(w.owner.root(base), w.owner.root({ ...base, cwd: 'c:\\PROJECT\\' }));
  assert.notEqual(w.owner.root(base), w.owner.root({ ...base, space: 'other' }));
  assert.notEqual(w.owner.root(base), w.owner.root({ ...base, cwd: 'C:/different' }));
  assert.notEqual(w.owner.root({ ...base, on: 'one' }), w.owner.root({ ...base, on: 'two' }));
});

test('expired shared cache returns immediately while the replacement is still reading', async () => {
  let now = 0, release;
  const w = world({ 'C:/project': [dir('a')], 'C:/project/a': [file('old.txt')] }, { Date: { now: () => now } });
  await w.drain(); const view = w.view(); await w.drain(); view.toggle('a', w.h.cx); await w.drain();
  now = 20000; w.tree['C:/project/a'] = () => new Promise(resolve => { release = resolve; });
  const result = await w.owner.read(view.context, 'a', view);
  assert.equal(result[0].name, 'old.txt');
  w.owner.pump(w.h.cx); await new Promise(setImmediate);
  assert.equal(view.entries.get('a')[0].name, 'old.txt');
  release([file('new.txt')]); await w.drain(); view.syncCatalog(w.h.cx);
  assert.equal(view.entries.get('a')[0].name, 'new.txt');
});

test('explicit requests run before speculative folders and get a separate batch', async () => {
  let release;
  const w = world({ 'C:/project': () => new Promise(resolve => { release = resolve; }), 'C:/project/b': [file('wanted.txt')] });
  const context = w.owner.active.context, pending = w.owner.read(context, 'b', {});
  release([dir('a'), dir('b'), dir('c')]); await w.drain();
  assert.equal((await pending)[0].name, 'wanted.txt');
  assert.deepEqual(Array.from(w.batches[1]), ['b']);
  assert.ok(w.batches.slice(2).flat().includes('a'));
  assert.equal(w.batches.flat().filter(path => path === 'b').length, 1);
});

test('in-flight reads are coalesced for multiple consumers', async () => {
  let release;
  const w = world({ 'C:/project': () => new Promise(resolve => { release = resolve; }) });
  const context = w.owner.active.context;
  const one = w.owner.read(context, '', {}), two = w.owner.read(context, '', {});
  release([file('same.txt')]); await w.drain();
  assert.equal((await one)[0].name, 'same.txt'); assert.equal((await two)[0].name, 'same.txt');
  assert.equal(w.batches.length, 1);
});

test('a result invalidated during its read cannot resolve consumers with old metadata', async () => {
  const w = world(); await w.drain(); let release;
  w.tree['C:/project/a'] = () => new Promise(resolve => { release = resolve; });
  const context = w.owner.active.context, pending = w.owner.read(context, 'a', {});
  w.owner.pump(w.h.cx); await new Promise(setImmediate);
  w.owner.invalidate(context, ['C:/project/a/new.txt']); w.tree['C:/project/a'] = [file('new.txt')];
  release([file('old.txt')]); await w.drain();
  assert.equal((await pending)[0].name, 'new.txt');
  assert.equal(w.batches.flat().filter(path => path === 'a').length, 2);
});

test('space changes stop old speculative traversal while preserving its completed root data', async () => {
  let release;
  const w = world({ 'C:/project': () => new Promise(resolve => { release = resolve; }), 'C:/second': [file('second.txt')] });
  const old = w.owner.active;
  w.h.state.space = 'second'; w.h.state.cwd = 'C:/second'; w.owner.sync(w.h.cx);
  release([dir('never-prefetch')]); await w.drain();
  assert.equal(old.cache.get('').items[0].name, 'never-prefetch');
  assert.equal(w.owner.active.cache.get('').items[0].name, 'second.txt');
  assert.ok(!w.batches.flat().includes('never-prefetch'));
});

test('warmup stops at its folder budget and shared cache stays within the entry budget', async () => {
  const tree = { 'C:/project': Array.from({ length: 200 }, (_, i) => dir(`d${i}`)) };
  const w = world(tree); await w.drain();
  assert.equal(w.batches.flat().length, 64);
  const root = w.owner.active;
  const cost = [...root.cache.values()].reduce((sum, entry) => sum + Math.max(1, entry.items?.length || 0), 0);
  assert.ok(cost <= 5000);
});

test('joining a background read promotes it so a full cache cannot strand its consumer', async () => {
  let release, count = 0;
  const tree = { 'C:/project': Array.from({ length: 20 }, (_, i) => dir(`d${i}`)) };
  for (let i = 0; i < 20; i++) tree[`C:/project/d${i}`] = Array.from({ length: 501 }, (_, n) => file(`f${n}`));
  const w = world(tree, { beforeBatch: async () => { if (++count === 3) await new Promise(resolve => { release = resolve; }); } });
  await new Promise(setImmediate);
  assert.ok(release); const wanted = w.batches[2].at(-1);
  const pending = w.owner.read(w.owner.active.context, wanted, {}); release(); await w.drain();
  assert.equal((await pending).length, 501);
  const cost = [...w.owner.active.cache.values()].reduce((sum, entry) => sum + Math.max(1, entry.items?.length || 0), 0);
  assert.ok(cost <= 5000); assert.ok(w.owner.active.cache.has(''));
});

test('refresh failure retains cached files and exposes a useful view error', async () => {
  const w = world({ 'C:/project': [dir('a')], 'C:/project/a': [file('retained.txt')] }); await w.drain();
  const view = w.view(); await w.drain(); view.toggle('a', w.h.cx); await w.drain();
  w.tree['C:/project/a'] = new Error('permission denied'); w.owner.invalidate(view.context, ['C:/project/a']);
  await w.drain(); view.syncCatalog(w.h.cx);
  assert.equal(view.entries.get('a')[0].name, 'retained.txt'); assert.match(view.cacheError, /permission denied/);
});

test('owner shutdown releases pending view requests into standalone fallback', async () => {
  const w = world({ 'C:/project': [dir('a')], 'C:/project/a': [file('fallback.txt')] }); await w.drain();
  const view = w.view(); await w.drain(); w.owner.active.cache.delete('a');
  view.toggle('a', w.h.cx); w.owner.close(); await w.h.drain();
  assert.equal(view.entries.get('a')[0].name, 'fallback.txt');
  assert.equal(w.api.getCatalog(), null);
});

test('shared refresh applies create, rename and delete to open tree rows', async () => {
  const w = world({ 'C:/project': [dir('a')], 'C:/project/a': [file('old.txt')] }); await w.drain();
  const view = w.view(); await w.drain(); view.toggle('a', w.h.cx); await w.drain();
  for (const names of [['old.txt', 'created.txt'], ['renamed.txt'], []]) {
    w.tree['C:/project/a'] = names.map(file); w.owner.invalidate(view.context, ['C:/project/a']);
    await w.drain(); view.syncCatalog(w.h.cx);
    assert.deepEqual(Array.from(view.entries.get('a'), entry => entry.name), [...names].sort((a, b) => a.localeCompare(b)));
  }
  w.tree['C:/project'] = [dir('renamed-folder')]; w.owner.invalidate(view.context, ['C:/project/a', 'C:/project/renamed-folder']);
  await w.drain(); view.syncCatalog(w.h.cx);
  assert.equal(view.folders.has('a'), false); assert.equal(view.entries.has('a'), false);
  assert.equal(view.entries.get('')[0].name, 'renamed-folder');
});

test('watcher bursts coalesce, refresh Git even when names do not change, and ignore own status writes', async () => {
  const w = world({ 'C:/app': [dir('a')], 'C:/app/a': [file('same.txt')] }, { root: 'C:/app' }); await w.drain();
  const view = w.view(); await w.drain(); view.toggle('a', w.h.cx); await w.drain();
  let release; w.h.scope.watchFolder = () => new Promise(resolve => { release = resolve; });
  w.watch.call(w.owner, w.owner.active, w.h.cx);
  const gitBefore = w.commands.filter(call => call.command === 'git').length;
  const signals = w.statuses.length;
  release(['C:/app/shared.json']); await new Promise(setImmediate);
  assert.equal(w.owner.active.gitVersion, 0);
  release(['C:/app/a/same.txt']); await new Promise(setImmediate);
  release(['C:/app/a/same.txt']); await new Promise(setImmediate);
  assert.equal(w.statuses.length, signals);
  const timers = w.h.timers.splice(0).filter(timer => timer.ms === 150);
  assert.equal(timers.length, 1); timers[0].fn(w.h.cx); await new Promise(setImmediate);
  view.syncCatalog(w.h.cx); await new Promise(setImmediate);
  assert.ok(w.commands.filter(call => call.command === 'git').length > gitBefore);
  assert.equal(view.catalogGitVersion, 2);
  w.owner.close(); release([]); await w.h.drain();
});

test('remote warmup uses the remote shell and keeps local Node out of the route', async () => {
  const calls = [];
  const w = world({}, { root: '/srv/project', on: 'remote', exec: async (command, args, options) => {
    calls.push({ command, options });
    return { code: 0, stdout: args.at(-1) === '/srv/project/' ? 'd\0child\0' : 'f\0remote.txt\0' };
  } });
  await w.drain();
  assert.equal(w.owner.active.cache.get('child').items[0].name, 'remote.txt');
  assert.ok(calls.every(call => call.command === 'sh' && call.options.on === 'remote'));
});

test('a failing Node process is remembered and later batches use the fallback directly', async () => {
  let nodes = 0, powershells = 0;
  const w = world({}, { exec: async command => {
    if (command === 'node') { nodes++; return { code: 1, stdout: '', stderr: 'runtime unavailable' }; }
    powershells++; return { code: 0, stdout: '[]', stderr: '' };
  } });
  await w.drain();
  const pending = w.owner.read(w.owner.active.context, 'another', {}); w.owner.pump(w.h.cx); await w.drain(); await pending;
  assert.equal(nodes, 1); assert.equal(powershells, 2);
});

test('large path payloads are split before exceeding the Windows command-line budget', async () => {
  const w = world(); await w.drain(); const root = w.owner.active;
  for (let i = 0; i < 8; i++) w.owner.enqueue(root, `${'long'.repeat(400)}/${i}`, false);
  w.owner.pump(w.h.cx); await w.drain();
  assert.ok(w.batches.slice(1).length > 1);
  assert.ok(w.batches.slice(1).every(batch => JSON.stringify(batch.map(path => ({ path, full: `C:/project/${path}` }))).length < 8100));
});

test('cancelled consumers do not leave a foreground job queued', async () => {
  const w = world(); await w.drain(); const client = {};
  const pending = w.owner.read(w.owner.active.context, 'missing', client);
  w.owner.cancel(client); await assert.rejects(pending, /cancelled/);
  assert.equal(w.owner.active.urgent.has('missing'), false);
});

test('context metadata and pending native watches are bounded across many roots', async () => {
  const w = world({}, { keepWatch: true });
  for (let i = 0; i < 12; i++) { w.h.state.cwd = `C:/root-${i}`; w.owner.sync(w.h.cx); await new Promise(setImmediate); }
  assert.ok(w.owner.roots.size <= 8); assert.ok(w.readers.length <= 8);
  w.owner.close(); for (const release of w.readers) release([]); await w.h.drain();
});

test('superseded owners cannot publish a late result', async () => {
  let release, first = true;
  const w = world({ 'C:/project': () => first ? new Promise(resolve => { release = resolve; }) : [file('new-owner.txt')] });
  first = false; const current = w.api.startCatalog(w.h.cx); release([file('old-owner.txt')]); await w.h.drain();
  assert.equal(w.owner.running, false); assert.equal(current.active.cache.get('').items[0].name, 'new-owner.txt');
});

test('real batched reader handles links and stops prefetching a physical-directory cycle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-warmup-'));
  try {
    await fs.mkdir(path.join(root, 'a')); await fs.mkdir(path.join(root, 'b'));
    await fs.writeFile(path.join(root, 'a', 'Tiếng Việt.txt'), 'data');
    await fs.symlink(root, path.join(root, 'a', 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
    const commands = [];
    const w = world({}, { root, exec: async (command, args) => {
      commands.push(command);
      const value = await execute(command === 'node' ? process.execPath : command, args, { windowsHide: true });
      return { code: 0, ...value };
    } });
    await w.drain();
    assert.equal(w.owner.active.cache.get('a').items.find(entry => entry.name === 'loop').dir, true);
    assert.ok(w.owner.active.cache.get('a').items.some(entry => entry.name === 'Tiếng Việt.txt'));
    assert.ok(w.owner.active.cache.has('a/loop')); assert.ok(w.owner.active.cache.size < 10);
    assert.ok(commands.length <= 4);
    const api = w.h.loadModule(directoryFile);
    const batch = await api.directoryBatch(['a', 'absent', 'b'], w.owner.active.context);
    assert.ok(batch.find(entry => entry.path === 'absent').error);
    assert.ok(batch.find(entry => entry.path === 'b').items);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'herdr-warmup-'));
    await fs.rm(root, { recursive: true, force: true });
  }
});
