const test = require('node:test');
const assert = require('node:assert/strict');
const { harness } = require('./files-harness.cjs');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const result = items => ({ code: 0, stdout: JSON.stringify(items), stderr: '' });

async function ready(options) { const h = harness(options); h.view.init({}, h.cx); await h.drain(); return h; }

test('reopening a fresh folder retains its listing without another subprocess', async () => {
  const h = harness(); h.view.init({}, h.cx); await h.drain();
  h.view.toggle('folder', h.cx); await h.drain();
  const reads = h.calls.length;
  h.view.toggle('folder', h.cx); h.view.toggle('folder', h.cx); await h.drain();
  assert.equal(h.calls.length, reads);
  assert.equal(h.view.entries.get('folder')[0].name, 'child.txt');
});

test('overlapping loads of one folder share a single directory read', async () => {
  const h = harness(); h.view.init({}, h.cx); await h.drain();
  h.view.folders.add('folder');
  const reads = h.calls.length;
  await Promise.all([h.view.loadFolder('folder', h.view.context, h.cx), h.view.loadFolder('folder', h.view.context, h.cx)]);
  assert.equal(h.calls.length - reads, 1);
});

test('expired cache revalidates a reopened folder', async () => {
  let now = 0;
  const h = await ready({ Date: { now: () => now } });
  h.view.toggle('folder', h.cx); await h.drain(); const reads = h.calls.length;
  h.view.toggle('folder', h.cx); now = 10001;
  h.view.toggle('folder', h.cx); await h.drain();
  assert.equal(h.calls.length, reads + 1);
});

test('watch invalidation covers parent listings and removed descendants, retaining unrelated cache', async () => {
  const h = await ready();
  await h.view.readDirectory('folder', h.view.context);
  await h.view.readDirectory('folder/nested', h.view.context);
  await h.view.readDirectory('unrelated', h.view.context);
  h.view.invalidateDirectories(['C:\\project\\folder'], h.view.context);
  assert.equal(h.view.context.cache.has(''), false);
  assert.equal(h.view.context.cache.has('folder'), false);
  assert.equal(h.view.context.cache.has('folder/nested'), false);
  assert.equal(h.view.context.cache.has('unrelated'), true);
});

test('invalidation during a read cannot cache or return the old result', async () => {
  let release, reads = 0;
  const h = await ready({ exec: async (command, args) => {
    if (command === 'git') return { code: 1, stdout: '' };
    if (args.at(-1).endsWith('/folder') && ++reads === 1) return new Promise(resolve => { release = resolve; });
    return result([{ name: 'new.txt', dir: false }]);
  } });
  const pending = h.view.readDirectory('folder', h.view.context);
  h.view.invalidateDirectories(['C:/project/folder/new.txt']);
  release(result([{ name: 'old.txt', dir: false }]));
  assert.equal((await pending)[0].name, 'new.txt');
  assert.equal(h.view.context.cache.get('folder').items[0].name, 'new.txt');
  assert.equal(h.view.context.reads.size, 0);
});

test('a root-level file event invalidates the Unix filesystem root listing', async () => {
  const h = await ready({ root: '/', platform: 'linux' });
  assert.ok(h.view.context.cache.has(''));
  h.view.invalidateDirectories(['/new-file']);
  assert.equal(h.view.context.cache.has(''), false);
});

test('search retains total-entry and depth limits while using cached directories', async () => {
  const h = await ready({ exec: async command => command === 'git' ? { code: 1, stdout: '' }
    : result([{ name: 'nested', dir: true }, { name: 'hit.txt', dir: false }]) });
  h.view.query.set('hit'); h.view.search(h.cx); await h.drain();
  assert.equal(h.view.searchLimited, true);
  assert.equal(h.view.results.length, 41);
  assert.ok(h.view.results.every(file => file.split('/').length <= 41));
  const items = [{ name: 'nested', dir: true }, ...Array.from({ length: 499 }, (_, i) => ({ name: `hit-${i}`, dir: false }))];
  h.scope.exec = async command => command === 'git' ? { code: 1, stdout: '' } : result(items);
  h.view.invalidateDirectories(); h.view.search(h.cx); await h.drain();
  assert.equal(h.view.searchLimited, true);
  assert.equal(h.view.results.length, 4990);
});

test('create, rename and delete become visible after invalidation', async () => {
  let names = ['before.txt'];
  const h = await ready({ exec: async command => command === 'git' ? { code: 1, stdout: '' } : result(names.map(name => ({ name, dir: false }))) });
  for (const next of [['before.txt', 'created.txt'], ['renamed.txt'], []]) {
    names = next; h.view.invalidateDirectories(['C:/project']); h.view.refresh(h.cx); await h.drain();
    assert.deepEqual(Array.from(h.view.entries.get(''), entry => entry.name), next);
  }
});

test('an unrelated watcher event does not restart an in-flight directory read', async () => {
  let release, reads = 0;
  const h = await ready({ exec: async (command, args) => {
    if (command === 'git') return { code: 1, stdout: '' };
    if (args.at(-1).endsWith('/folder')) { reads++; return new Promise(resolve => { release = resolve; }); }
    return result([]);
  } });
  const pending = h.view.readDirectory('folder', h.view.context);
  h.view.invalidateDirectories(['C:/project/unrelated/file.txt']);
  release(result([{ name: 'current.txt', dir: false }]));
  assert.equal((await pending)[0].name, 'current.txt'); assert.equal(reads, 1);
});

test('unchanged refresh does not redraw for every expanded folder', async () => {
  let notifications = 0;
  const h = await ready({ notify: () => { notifications++; }, exec: async (command, args) => {
    if (command === 'git') return { code: 1, stdout: '' };
    return result(args.at(-1) === 'C:/project' ? [{ name: 'folder', dir: true }] : []);
  } });
  h.view.toggle('folder', h.cx); await h.drain(); notifications = 0;
  h.view.refresh(h.cx); await h.drain();
  assert.equal(notifications, 1);
});

test('removed open folders are pruned without aborting subsequent refresh', async () => {
  let exists = true;
  const h = await ready({ exec: async (command, args) => {
    if (command === 'git') return { code: 1, stdout: '' };
    return result(args.at(-1) === 'C:/project' && exists ? [{ name: 'folder', dir: true }] : []);
  } });
  h.view.toggle('folder', h.cx); await h.drain(); exists = false;
  h.view.invalidateDirectories(['C:/project/folder']); h.view.refresh(h.cx); await h.drain();
  assert.equal(h.view.folders.has('folder'), false);
  assert.equal(h.view.entries.has('folder'), false);
  assert.equal(h.view.error, null);
});

test('an old context load cannot publish into a new tree', async () => {
  let release;
  const h = await ready({ exec: async (command, args) => {
    if (command === 'git') return { code: 1, stdout: '' };
    if (args.at(-1) === 'C:/project/folder') return new Promise(resolve => { release = resolve; });
    return result([{ name: 'current.txt', dir: false }]);
  } });
  h.view.toggle('folder', h.cx); h.state.cwd = 'C:/different'; h.view.refresh(h.cx);
  release(result([{ name: 'stale.txt', dir: false }])); await h.drain();
  assert.equal(h.view.root, 'C:/different');
  assert.equal(h.view.entries.has('folder'), false);
});

test('search debounces typing and uses the same fresh directory cache', async () => {
  const h = await ready(); const reads = h.calls.length;
  for (const query of ['c', 'chi', 'child']) { h.view.query.set(query); h.view.scheduleSearch(h.cx); }
  assert.equal(h.view.results.length, 0); await h.tick();
  assert.deepEqual(Array.from(h.view.results), ['child.txt']);
  assert.equal(h.calls.length, reads);
  h.view.query.set('nothing'); h.view.scheduleSearch(h.cx); await h.tick();
  assert.equal(h.view.results.length, 0);
  assert.equal(h.calls.length, reads);
});

test('directory and cache budgets stay bounded even for collapsed folders', async () => {
  const items = Array.from({ length: 501 }, (_, i) => ({ name: `file-${i}`, dir: false }));
  const h = await ready({ exec: async command => command === 'git' ? { code: 1, stdout: '' } : result(items) });
  assert.equal(h.view.entries.get('').length, 500); assert.equal(h.view.limited, true);
  for (let i = 0; i < 14; i++) { h.view.toggle(`folder-${i}`, h.cx); await h.drain(); h.view.toggle(`folder-${i}`, h.cx); }
  const budget = [...h.view.context.cache.values()].reduce((sum, cached) => sum + Math.max(1, cached.items.length), 0);
  assert.ok(budget <= 5000);
});

test('Git marks and missing paths retain Windows normalization and existence checks', async () => {
  const h = await ready({ exec: async (command, args) => {
    if (command !== 'git') return result([]);
    if (args[0] === 'rev-parse') return { code: 0, stdout: 'C:/project\n' };
    return { code: 0, stdout: ' M changed.txt\0D  missing.txt\0D  staged-but-present.txt\0?? new.txt\0' };
  }, readTextFile: async file => file.endsWith('missing.txt') ? null : 'present' });
  assert.equal(h.view.mark('CHANGED.txt'), 'M'); assert.equal(h.view.mark('new.txt'), 'A');
  assert.equal(h.view.isMissing('MISSING.txt'), true); assert.equal(h.view.isMissing('staged-but-present.txt'), false);
  h.view.context.windows = false; h.view.indexMarks();
  assert.equal(h.view.mark('CHANGED.txt'), ''); assert.equal(h.view.mark('changed.txt'), 'M');
});

test('root entries notify before a slow Git probe completes', async () => {
  let release, started;
  const gitStarted = new Promise(resolve => { started = resolve; }); const notifications = [];
  const h = harness({ notify: view => notifications.push(view.entries.has('')), exec: async command => {
    if (command === 'git') { started(); return new Promise(resolve => { release = resolve; }); }
    return result([{ name: 'ready.txt', dir: false }]);
  } });
  h.view.init({}, h.cx); await gitStarted;
  assert.ok(notifications.includes(true));
  release({ code: 1, stdout: '' }); await h.drain();
});

test('a refresh arriving during a load is replayed rather than lost', async () => {
  let release, started, first = true, name = 'old.txt';
  const gitStarted = new Promise(resolve => { started = resolve; });
  const h = harness({ exec: async command => {
    if (command !== 'git') return result([{ name, dir: false }]);
    if (first) { first = false; started(); return new Promise(resolve => { release = resolve; }); }
    return { code: 1, stdout: '' };
  } });
  h.view.init({}, h.cx); await gitStarted;
  name = 'new.txt'; h.view.invalidateDirectories(['C:/project']); h.view.refresh(h.cx);
  release({ code: 1, stdout: '' }); await h.drain();
  assert.equal(h.view.entries.get('')[0].name, 'new.txt'); assert.equal(h.view.loading, false);
});

test('watcher bursts invalidate immediately and schedule only one refresh', async () => {
  const h = await ready(); let release;
  h.scope.watchFolder = () => new Promise(resolve => { release = resolve; });
  h.scope.Files.prototype.watch.call(h.view, h.view.root, h.cx);
  release(['C:/project/one.txt']); await new Promise(setImmediate);
  release(['C:/project/two.txt']); await new Promise(setImmediate);
  assert.equal(h.view.context.cache.has(''), false);
  assert.equal(h.timers.filter(timer => timer.ms === 150).length, 1);
  h.view.context = null; release([]); await h.drain();
});

test('missing Node uses PowerShell and remembers the fallback', async () => {
  let nodeCalls = 0, powershellCalls = 0;
  const h = await ready({ exec: async command => {
    if (command === 'git') return { code: 1, stdout: '' };
    if (command === 'node') { nodeCalls++; throw new Error('cannot start node: program not found'); }
    powershellCalls++; return result([]);
  } });
  await h.view.readDirectory('folder', h.view.context);
  assert.equal(nodeCalls, 1); assert.equal(powershellCalls, 2);
});

test('remote listing stays on its machine and never invokes local Node', async () => {
  const calls = [];
  const h = await ready({ root: '/srv/project', on: 'remote', platform: 'windows', exec: async (command, args, options) => {
    calls.push({ command, options });
    if (command === 'git') return { code: 1, stdout: '' };
    return { code: 0, stdout: args.includes('uname -s') ? 'Linux\n' : 'f\0remote.txt\0' };
  } });
  assert.equal(h.view.entries.get('')[0].name, 'remote.txt');
  assert.ok(calls.every(call => call.options.on === 'remote'));
  assert.ok(calls.every(call => call.command !== 'node'));
});

test('auto-save retains a draft before writing and clears it after snapshot-checked save', async () => {
  const writes = [];
  const h = await ready({ props: { root: 'C:/project', file: 'file.txt', space: 's' }, writeTextFile: async (...args) => writes.push(args) });
  h.view.code.set('edited'); h.view.scheduleSave(h.cx);
  assert.equal(h.storage.size, 1); assert.ok(h.timers.some(timer => timer.ms === 800));
  await h.tick();
  assert.deepEqual(writes[0], ['C:/project/file.txt', 'edited', 'original']);
  assert.equal(h.view.snapshot, 'edited'); assert.equal(h.storage.size, 0);
});

test('remote platform detection retries after a temporary probe failure', async () => {
  let available = false, probes = 0;
  const h = await ready({ on: 'remote', exec: async (command, args) => {
    if (command === 'git') return { code: 1, stdout: '' };
    if (command === 'sh' && args.includes('uname -s')) { probes++; return { code: 1, stdout: '' }; }
    if (command === 'cmd') return { code: available ? 0 : 1, stdout: '' };
    return { code: 0, stdout: 'f\0remote.txt\0' };
  } });
  assert.equal(h.view.context.windows, false); available = true;
  h.view.refresh(h.cx); await h.drain();
  assert.equal(h.view.context.windows, true); assert.equal(probes, 2);
});

test('failed auto-save pauses writes and retains recoverable draft', async () => {
  const h = await ready({ props: { root: 'C:/project', file: 'file.txt', space: 's' }, writeTextFile: async () => { throw new Error('stale snapshot'); } });
  h.view.code.set('edited'); h.view.scheduleSave(h.cx); await h.tick();
  assert.equal(h.view.savePaused, true); assert.equal(h.view.external, true);
  assert.equal(JSON.parse([...h.storage.values()][0]).text, 'edited');
});

test('binary disk file restores full draft as read-only', async () => {
  const draft = { root: 'C:/project', on: null, file: 'binary.dat', snapshot: 'old', text: 'unsaved draft' };
  const h = await ready({ props: { root: 'C:/project', file: 'binary.dat', space: 's', draft }, readTextFile: async () => '\0binary' });
  assert.equal(h.view.code.value(), draft.text); assert.equal(h.view.editable, false);
  assert.equal(h.view.dirty(), true); assert.equal(h.storage.size, 1);
});

test('real directory helper preserves Unicode, hidden names, links, bounds and read errors', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-files-test-'));
  const target = path.join(fixture, 'target'), link = path.join(fixture, 'linked');
  try {
    await fs.mkdir(target); await fs.writeFile(path.join(fixture, 'Tiếng Việt & quote\'file.txt'), 'text');
    await fs.writeFile(path.join(fixture, '.hidden'), 'text'); await fs.mkdir(path.join(fixture, '.GIT'));
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    await fs.symlink(path.join(fixture, 'absent'), path.join(fixture, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
    const h = harness({ exec: async (command, args) => {
      const { stdout, stderr } = await execute(command === 'node' ? process.execPath : command, args, { windowsHide: true });
      return { code: 0, stdout, stderr };
    } });
    const list = await h.scope.directory(fixture, null, {});
    assert.equal(list.find(entry => entry.name === 'linked').dir, true);
    assert.equal(list.find(entry => entry.name === 'dangling').dir, false);
    assert.ok(list.some(entry => entry.name === 'Tiếng Việt & quote\'file.txt'));
    assert.ok(list.some(entry => entry.name === '.hidden')); assert.ok(!list.some(entry => entry.name.toLowerCase() === '.git'));
    await Promise.all(Array.from({ length: 510 }, (_, i) => fs.writeFile(path.join(fixture, `extra-${i}`), '')));
    assert.equal((await h.scope.directory(fixture, null, {})).length, 501);
    await assert.rejects(h.scope.directory(path.join(fixture, 'nonexistent'), null, {}));
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
});
