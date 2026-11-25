const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function moduleLoader(scope) {
  const context = vm.createContext(scope), cache = new Map();
  const herdr = new Proxy(scope, { get(target, key) {
    return typeof target[key] === 'function' ? (...args) => target[key](...args) : target[key];
  } });
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename);
    const exports = {}; cache.set(filename, exports);
    const modules = [], names = [], original = fs.readFileSync(filename, 'utf8');
    let source = original.replace(/^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?\r?\n/gm, (_match, bindings, name) => {
      const dependency = name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : name === 'herdr' ? herdr : scope;
      modules.push(dependency);
      return `const {${bindings.replace(/\bas\b/g, ':')}} = __modules[${modules.length - 1}];\n`;
    });
    const defaultClass = source.match(/export default class (\w+)/)?.[1];
    source = source.replace(/export default class /g, 'class ')
      .replace(/^export ((?:async\s+)?(?:function|class|const|let)\s+)(\w+)/gm, (_match, prefix, name) => { names.push(name); return prefix + name; });
    const ending = names.map(name => `exports.${name} = ${name};`).join('\n')
      + (defaultClass ? `\nexports.default = ${defaultClass};` : '')
      + '\nif (typeof directory === "function") exports.directory = directory;';
    const factory = vm.runInContext(`(function(__modules, exports) {\n${source}\n${ending}\n})`, context, { filename });
    factory(modules, exports); return exports;
  }
  return load;
}

function harness(options = {}) {
  const filename = options.source || process.env.FILES_SOURCE || path.join(__dirname, '../mods/claude-files-261106/main.js');
  const state = { cwd: options.root || 'C:/project', on: options.on || null, props: options.props || {}, space: options.space || 's' };
  const jobs = [], timers = [], storage = new Map(), calls = [];
  const editor = value => ({ value: () => value, set: next => { value = next; }, on() {}, release() {} });
  const scope = {
    View: class {}, console, Date: options.Date || Date,
    spaces: () => [{ id: state.space, active: true, folder: state.cwd, machine: state.on }],
    panes: () => [{ pane: 'p', cwd: state.cwd }], focused: () => ({ pane: 'p', tab: 't', cwd: state.cwd }),
    window: () => ({ platform: options.platform || 'windows' }), props: () => state.props,
    theme: () => ({}), settings: () => ({}), shared: () => null,
    setShared: (...args) => { if (options.onShared) options.onShared(...args); }, appHome: () => 'C:/app',
    InputState: { new: () => editor('') }, EditorState: { new: opts => editor(opts.value) },
    exec: options.exec || (async (command, args, opts) => {
      calls.push({ command, args, opts });
      return command === 'git' ? { code: 1, stdout: '', stderr: '' }
        : { code: 0, stdout: JSON.stringify([{ name: 'child.txt', dir: false }]), stderr: '' };
    }),
    readTextFile: options.readTextFile || (async () => 'original'),
    writeTextFile: options.writeTextFile || (async () => {}),
    watchFolder: options.watchFolder || (() => new Promise(() => {})),
    run: (...args) => calls.push({ run: args }),
    localStorage: {
      get length() { return storage.size; }, key: index => [...storage.keys()][index],
      getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key), flush: async () => {}
    }
  };
  const loadModule = moduleLoader(scope), loaded = loadModule(filename);
  scope.Files = loaded.default; scope.directory = loaded.directory;
  const cx = {
    spawn: fn => { const job = fn(cx); jobs.push(job); return job; },
    notify: () => { if (options.notify) options.notify(view); },
    timer: { every() {}, after: (ms, fn) => timers.push({ ms, fn }) },
    focus_handle: () => ({ focus() {}, release() {} })
  };
  const view = new scope.Files();
  // Watch loops are tested separately; other harness jobs must settle deterministically.
  if (!options.watchFolder) view.watch = () => {};
  async function drain() { while (jobs.length) await Promise.all(jobs.splice(0)); }
  async function tick() { for (const timer of timers.splice(0)) timer.fn(cx); await drain(); }
  return { view, state, scope, cx, jobs, timers, storage, calls, drain, tick, loadModule };
}

module.exports = { harness, moduleLoader };
