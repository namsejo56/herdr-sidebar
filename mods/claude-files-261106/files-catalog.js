import { setShared, watchFolder, window, appHome } from "herdr";
import { directoryBatch } from "./files-directory.js";
import { location, catalogKey, affectsFolder, normalized, joinPath, rootPath } from "./files-paths.js";

const TTL = 10000, MAX_ENTRIES = 5000, MAX_ROOTS = 8, MAX_WARM_FOLDERS = 64;
let owner;

export function getCatalog() { return owner?.running ? owner : null; }

export function startCatalog(cx) {
  owner?.close();
  owner = new FilesCatalog();
  owner.start(cx);
  return owner;
}

export class FilesCatalog {
  constructor() {
    this.roots = new Map(); this.running = true; this.pumping = false;
    this.watchers = new Map();
    this.revision = 0; this.active = null; this.previous = null;
  }

  start(cx) {
    this.sync(cx);
    cx.timer.every(TTL, cx => this.poll(cx));
  }

  root(context) {
    const key = catalogKey(context);
    let root = this.roots.get(key);
    if (!root) {
      const space = context.space ?? (context.key ? JSON.parse(context.key).space : null);
      root = { key, context: { cwd: context.cwd, on: context.on ?? null, space, windows: context.windows }, cache: new Map(), urgent: new Map(), inflight: new Map(),
        waiters: new Map(), hints: [], todo: [], queued: new Set(), seen: new Set(), real: new Set(),
        scanned: 0, folders: 0, version: 0, gitVersion: 0, watching: false, watchQueued: false };
    }
    if (!context.on || context.windows) root.context.windows = context.windows;
    this.roots.delete(key); this.roots.set(key, root);
    while (this.roots.size > MAX_ROOTS) {
      const oldest = [...this.roots.values()].find(value => value !== this.active && value !== root);
      this.roots.delete(oldest.key); this.settleAll(oldest, null);
    }
    return root;
  }

  peek(context) { return context?.cwd ? this.roots.get(catalogKey(context)) : null; }

  sync(cx) {
    if (!this.running) return;
    const context = location(this.previous);
    context.key = JSON.stringify(context);
    this.previous = context;
    if (!context.cwd) { this.active = null; return; }
    const root = this.root(context);
    if (root !== this.active) {
      if (this.active) {
        this.active.todo = []; this.active.queued.clear();
        for (const path of this.active.urgent.keys()) if (!this.active.waiters.has(path)) this.active.urgent.delete(path);
      }
      this.active = root;
      if (!context.on) root.context.windows = window()?.platform === "windows";
      root.seen.clear(); root.real.clear(); root.scanned = 0; root.folders = 0;
      root.todo = ["", ...root.hints].map(path => ({ path, depth: path ? path.split("/").length : 0 }));
      root.queued = new Set(root.todo.map(item => item.path));
      this.signal();
      this.watch(root, cx);
    }
    this.pump(cx);
  }

  hint(context, path) {
    const root = this.root(context);
    root.hints = [path, ...root.hints.filter(value => value !== path)].slice(0, 32);
  }

  read(context, path, client) {
    const root = this.root(context), entry = root.cache.get(path);
    this.hint(context, path);
    if (entry?.items) {
      root.cache.delete(path); root.cache.set(path, entry);
      if ((entry.stale || Date.now() - entry.time >= TTL) && Date.now() >= (entry.retryAt || 0)) this.enqueue(root, path);
      return Promise.resolve(entry.items);
    }
    if (entry?.error && Date.now() < entry.retryAt) return Promise.reject(new Error(entry.error));
    const promise = new Promise((resolve, reject) => {
      if (!root.waiters.has(path)) root.waiters.set(path, new Set());
      root.waiters.get(path).add({ client, resolve, reject });
    });
    this.enqueue(root, path);
    return promise;
  }

  enqueue(root, path, wake = true, priority = 2) {
    const inflight = root.inflight.get(path);
    if (inflight) { if (priority >= 2) inflight.foreground = true; }
    else root.urgent.set(path, { path, depth: path ? path.split("/").length : 0, priority: Math.max(priority, root.urgent.get(path)?.priority || 0) });
    if (wake && !this.pumping) this.signal();
  }

  signal() {
    if (!this.running) return;
    setShared("files.catalog.status.v1", { revision: ++this.revision, active: this.active?.key ?? null,
      roots: this.roots.size, folders: this.active?.cache.size || 0,
      entries: this.active ? [...this.active.cache.values()].reduce((sum, entry) => sum + (entry.items?.length || 0), 0) : 0,
      ready: Boolean(this.active?.cache.get("")?.items) });
  }

  cancel(client) {
    for (const root of this.roots.values()) for (const [path, waiters] of root.waiters) {
      for (const waiter of waiters) if (waiter.client === client) { waiter.reject(new Error("Folder request cancelled")); waiters.delete(waiter); }
      if (!waiters.size) { root.waiters.delete(path); if (!root.cache.has(path)) root.urgent.delete(path); }
    }
  }

  settle(root, path, entry) {
    const waiters = root.waiters.get(path);
    if (!waiters) return;
    root.waiters.delete(path);
    for (const waiter of waiters) entry.error && !entry.items ? waiter.reject(new Error(entry.error)) : waiter.resolve(entry.items);
  }

  settleAll(root, items) {
    for (const waiters of root.waiters.values()) for (const waiter of waiters) waiter.resolve(items);
    root.waiters.clear();
  }

  close() {
    this.running = false;
    for (const root of this.roots.values()) this.settleAll(root, null);
  }

  visit(root, task, entry) {
    if (root !== this.active || root.seen.has(task.path)) return;
    root.seen.add(task.path); root.folders++; root.scanned += Math.max(1, entry.items.slice(0, 500).length);
    if (entry.real && root.real.has(normalized(entry.real, root.context.windows))) return;
    if (entry.real) root.real.add(normalized(entry.real, root.context.windows));
    if (task.depth >= 40 || root.scanned >= MAX_ENTRIES || root.folders >= MAX_WARM_FOLDERS) return;
    for (const item of entry.items.slice(0, 500)) if (item.dir) {
      const path = task.path ? `${task.path}/${item.name}` : item.name;
      if (!root.seen.has(path) && !root.queued.has(path)) { root.todo.push({ path, depth: task.depth + 1 }); root.queued.add(path); }
    }
  }

  nextBatch() {
    const roots = [...this.roots.values()];
    const userRequest = root => [...root.urgent.values()].some(task => task.priority >= 2);
    const urgentRoot = roots.find(root => root === this.active && userRequest(root)) || roots.find(userRequest)
      || roots.find(root => root.urgent.size && root === this.active) || roots.find(root => root.urgent.size);
    const root = urgentRoot || this.active;
    if (!root) return null;
    const userBatch = urgentRoot && userRequest(urgentRoot);
    const limit = !root.context.on && window()?.platform === "windows" && !root.context.noNode ? 8 : 1;
    const tasks = []; let argumentSize = 0;
    while (tasks.length < limit) {
      if (userBatch && !userRequest(root)) break;
      let task;
      if (root.urgent.size) {
        task = [...root.urgent.values()].reduce((best, value) => !best || value.priority > best.priority ? value : best, null);
        root.urgent.delete(task.path); task.foreground = task.priority >= 2;
      }
      else {
        if (root !== this.active || root.scanned >= MAX_ENTRIES || root.folders + tasks.filter(task => !task.foreground).length >= MAX_WARM_FOLDERS) break;
        task = root.todo.shift(); if (!task) break; root.queued.delete(task.path);
        if (root.seen.has(task.path)) continue;
        const cached = root.cache.get(task.path);
        if (cached?.items && !cached.stale && Date.now() - cached.time < TTL) { this.visit(root, task, cached); continue; }
      }
      if (root.inflight.has(task.path)) continue;
      const size = JSON.stringify({ path: task.path, full: joinPath(root.context.cwd, task.path) }).length;
      if (tasks.length && argumentSize + size > 8000) {
        if (task.priority) root.urgent.set(task.path, task);
        else { root.todo.unshift(task); root.queued.add(task.path); }
        break;
      }
      argumentSize += size;
      root.inflight.set(task.path, task); tasks.push(task);
    }
    return tasks.length ? { root, tasks } : null;
  }

  store(root, task, result) {
    const previous = root.cache.get(task.path);
    const entry = result.error ? { ...previous, error: result.error, stale: true, retryAt: Date.now() + 2000 }
      : { items: result.items, real: result.real, time: Date.now(), stale: false };
    const cost = items => Math.max(1, items?.length || 0);
    let used = [...root.cache.entries()].reduce((sum, [path, value]) => sum + (path === task.path ? 0 : cost(value.items)), 0);
    if (!task.foreground && used + cost(entry.items) > MAX_ENTRIES) { root.todo = []; root.queued.clear(); return false; }
    while (used + cost(entry.items) > MAX_ENTRIES) {
      const oldest = [...root.cache.keys()].find(path => path !== "" && path !== task.path);
      if (oldest === undefined) break;
      used -= cost(root.cache.get(oldest).items); root.cache.delete(oldest);
    }
    root.cache.delete(task.path); root.cache.set(task.path, entry);
    this.settle(root, task.path, entry);
    if (previous?.error && !previous.items && entry.items && root.seen.delete(task.path)) root.folders--;
    if (entry.items) this.visit(root, task, entry);
    else if (root === this.active && !root.seen.has(task.path)) { root.seen.add(task.path); root.folders++; }
    return JSON.stringify(previous?.items) !== JSON.stringify(entry.items) || previous?.error !== entry.error;
  }

  pump(cx) {
    if (!this.running || this.pumping) return;
    const warm = this.active && this.active.todo.length && this.active.scanned < MAX_ENTRIES && this.active.folders < MAX_WARM_FOLDERS;
    if (!warm && ![...this.roots.values()].some(root => root.urgent.size)) return;
    this.pumping = true;
    cx.spawn(async cx => {
      try {
        for (;;) {
          const batch = this.nextBatch(); if (!batch || !this.running) break;
          const { root, tasks } = batch;
          let results;
          try { results = await directoryBatch(tasks.map(task => task.path), root.context); }
          catch (error) { results = tasks.map(task => ({ path: task.path, error: String(error) })); }
          if (!this.running) break;
          if (this.roots.get(root.key) !== root) continue;
          let changed = false;
          for (const task of tasks) {
            root.inflight.delete(task.path);
            if (task.invalidated) { this.enqueue(root, task.path, true, task.foreground ? 2 : 1); continue; }
            const result = results.find(value => value.path === task.path) || { error: "Cannot list this folder" };
            changed = this.store(root, task, result) || changed;
          }
          if (changed) { root.version++; this.signal(); }
        }
      } finally { this.pumping = false; }
    });
  }

  invalidate(context, paths, wake = true) {
    const root = this.peek(context); if (!root) return;
    for (const path of new Set([...root.cache.keys(), ...root.inflight.keys()])) if (affectsFolder(path, paths, root.context)) {
      const entry = root.cache.get(path); if (entry) entry.stale = true;
      const task = root.inflight.get(path); if (task) task.invalidated = true;
      if (root === this.active) this.enqueue(root, path, wake, 1);
    }
  }

  watch(root, cx) {
    if (root.context.on || root.watching || this.watchers.has(root.key) || this.watchers.size >= MAX_ROOTS) return;
    root.watching = true;
    this.watchers.set(root.key, root);
    cx.spawn(async cx => {
      try {
        while (this.running && this.active === root && this.roots.get(root.key) === root) {
          const paths = await watchFolder(root.context.cwd);
          if (!this.running || this.roots.get(root.key) !== root) return;
          // Publishing our small revision writes this bookkeeping file. Its
          // contents do not change a directory listing and must not feed back.
          const ownState = normalized(joinPath(appHome(), "shared.json"), root.context.windows);
          const changed = paths.filter(path => normalized(rootPath(path), root.context.windows) !== ownState);
          if (!changed.length) continue;
          this.invalidate(root.context, changed, false);
          root.gitVersion++;
          if (!root.watchQueued && this.active === root) {
            root.watchQueued = true;
            cx.timer.after(150, cx => { root.watchQueued = false; if (this.running) { this.signal(); this.pump(cx); } });
          }
        }
      } catch { /* Polling revalidates roots and requested folders if watching fails. */ }
      finally { root.watching = false; if (this.watchers.get(root.key) === root) this.watchers.delete(root.key); }
    });
  }

  poll(cx) {
    if (!this.running) return;
    this.sync(cx);
    const root = this.active; if (!root) return;
    for (const path of ["", ...root.hints]) {
      const entry = root.cache.get(path);
      if (entry && (entry.stale || Date.now() - entry.time >= TTL) && Date.now() >= (entry.retryAt || 0)) this.enqueue(root, path, true, 1);
    }
    this.watch(root, cx); this.pump(cx);
  }
}
