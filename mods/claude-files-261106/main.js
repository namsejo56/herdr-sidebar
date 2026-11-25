// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, window, props, run, shared } from "herdr";
import { location, normalized, rootPath, joinPath } from "./files-paths.js";
import { directory } from "./files-directory.js";
import { getCatalog, startCatalog } from "./files-catalog.js";

const key = previous => JSON.stringify(location(previous));
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const DRAFT_PREFIX = "draft:";
const draftId = () => `${DRAFT_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
const CACHE_MS = 10000;
// A short-lived optional helper avoids PowerShell startup. All paths are argv,
// never interpolated into JavaScript or shell text. Remote listing stays on its machine.
export default class Files extends View {
  init(_props, cx) {
    const initial = props() || {};
    this.catalogService = initial.catalogService === true;
    if (this.catalogService) { this.catalog = startCatalog(cx); return; }
    this.viewer = typeof initial.file === "string" && typeof initial.root === "string";
    this.catalogApplied = new Map(); this.catalogVersion = -1; this.catalogGitVersion = 0;
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {}; this.missing = new Set();
    this.query = InputState.new({ placeholder: "Search filenames" });
    this.query.on("change", (_e, cx) => this.scheduleSearch(cx));
    this.searchVersion = 0; this.results = []; this.mode = "raw";
    this.openVersion = 0; this.draftKey = null;
    this.saveVersion = 0; this.savePaused = false;
    this.markIndex = new Map(); this.missingIndex = new Set();
    this.handles = new Map();
    for (const id of ["files-back", "raw", "content", "save", "reload", "keep", "confirm-save", "confirm-discard", "confirm-stay"]) this.ensureHandle(id, cx);
    this.searchQueued = false; this.searchStarted = 0;
    if (this.viewer) {
      this.root = initial.root; this.on = initial.on || null;
      this.context = { key: JSON.stringify({ cwd: this.root, on: this.on, space: initial.space }), cwd: this.root, on: this.on, windows: !this.on && window()?.platform === "windows" };
      let draft = initial.draft;
      if (draft) {
        try { const key = draftId(); localStorage.setItem(key, JSON.stringify(draft)); draft = { ...draft, key }; }
        catch { this.draftError = true; }
      }
      this.show(initial.file, cx, draft);
    } else this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  dirty() { return Boolean(this.code && (this.editable || this.draftKey) && this.code.value() !== this.snapshot); }

  scheduleSave(cx) {
    const version = ++this.saveVersion;
    this.persist();
    if (!this.editable || this.savePaused || this.external || !this.dirty()) return;
    this.note = "Waiting to save";
    cx.timer.after(800, cx => { if (version === this.saveVersion) this.save(cx); });
  }

  ensureHandle(id, cx) { if (!this.handles.has(id)) this.handles.set(id, cx.focus_handle()); }

  control(element, id, action, t, bordered = true) {
    const handle = this.handles.get(id);
    if (!handle) return element;
    return element.id(id).track_focus(handle).tab_index(0).role("button")
      .when(bordered, el => el.border_1().border_color(t.border))
      .focus(s => bordered ? s.border_color(t.foreground).bg(t.hover) : s.bg(t.hover))
      .cursor_pointer().hover(s => s.bg(t.hover))
      .on_click((e, cx) => { handle.focus(); action(e, cx); })
      .on_key_down((e, cx) => { if (e.keystroke === "enter" || e.keystroke === "space") { cx.stop_propagation(); action(e, cx); } });
  }

  refreshSearch(cx) {
    if (!this.query.value().trim()) return;
    if (this.searching) this.searchQueued = true;
    else this.search(cx);
  }

  scheduleSearch(cx) {
    const version = ++this.searchVersion;
    this.results = []; this.searchQueued = false;
    this.searching = Boolean(this.query.value().trim());
    if (!this.searching) { this.search(cx); return; }
    cx.timer.after(180, cx => { if (version === this.searchVersion) this.search(cx); });
    cx.notify();
  }

  drafts() {
    const drafts = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key !== "draft" && !key?.startsWith(DRAFT_PREFIX)) continue;
        try {
          const draft = JSON.parse(localStorage.getItem(key));
          if (draft && draft.root === this.root && draft.on === this.on && (!draft.context || draft.context === this.context?.key) && typeof draft.file === "string" && typeof draft.text === "string" && typeof draft.snapshot === "string") drafts.push({ ...draft, key });
        } catch { this.draftError = true; }
      }
    } catch { this.draftError = true; }
    return drafts;
  }

  persist() {
    try {
      if (this.dirty()) {
        if (!this.draftKey) this.draftKey = draftId();
        localStorage.setItem(this.draftKey, JSON.stringify({ root: this.root, on: this.on, context: this.context?.key, file: this.file, snapshot: this.snapshot, text: this.code.value() }));
      } else if (this.draftKey) {
        localStorage.removeItem(this.draftKey);
        this.draftKey = null;
      }
      this.draftError = false;
    } catch { this.draftError = true; }
  }

  async close() {
    if (this.catalogService) { this.catalog.close(); return; }
    getCatalog()?.cancel(this);
    this.persist();
    try { await localStorage.flush(); } catch { this.draftError = true; }
    for (const handle of this.handles.values()) handle.release();
  }

  search(cx) {
    const version = ++this.searchVersion, context = this.context, q = this.query.value().trim().toLowerCase();
    this.searchQueued = false; this.searchStarted = Date.now();
    this.results = []; this.searchError = null; this.searchLimited = false;
    if (!q || !context?.cwd) { this.searching = false; cx.notify(); return; }
    this.searching = true;
    cx.spawn(async cx => {
      const queue = [{ path: "", depth: 0 }], found = []; let count = 0;
      try {
        while (queue.length && version === this.searchVersion && this.current(context)) {
          const folder = queue.shift();
          let items;
          try { items = await this.readDirectory(folder.path, context); }
          catch (e) { if (version === this.searchVersion && this.current(context)) this.searchError = `Search incomplete: ${e}`; continue; }
          if (version !== this.searchVersion || !this.current(context)) return;
          if (items.length > PER_FOLDER) this.searchLimited = true;
          for (const item of items.slice(0, PER_FOLDER)) {
            if (++count > TOTAL) { this.searchLimited = true; break; }
            const path = folder.path ? `${folder.path}/${item.name}` : item.name;
            if (item.dir) { if (folder.depth < 40) queue.push({ path, depth: folder.depth + 1 }); else this.searchLimited = true; }
            else if (item.name.toLowerCase().includes(q)) found.push(path);
          }
          if (count > TOTAL) break;
        }
        if (version === this.searchVersion && this.current(context)) this.results = found;
        if (version === this.searchVersion && this.current(context)) {
          const prefix = normalized(joinPath(context.cwd, ""), context.windows);
          for (const full of Object.keys(this.marks)) {
            const inside = normalized(full, context.windows).startsWith(prefix);
            if (inside && this.missing.has(full)) { const path = full.slice(prefix.length); if (path.split("/").pop().toLowerCase().includes(q) && !found.includes(path)) found.push(path); }
          }
          this.results = found;
          for (const path of found) this.ensureHandle(`result-${path}`, cx);
        }
      } catch (e) { if (version === this.searchVersion && this.current(context)) { this.results = found; for (const path of found) this.ensureHandle(`result-${path}`, cx); this.searchError = `Search incomplete: ${e}`; } }
      finally { if (version === this.searchVersion) { this.searching = false; if (this.searchQueued && this.current(context)) this.search(cx); } cx.notify(); }
    });
    cx.notify();
  }

  watch(root, cx) {
    if (getCatalog()) return;
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.context === context) {
          const paths = await watchFolder(root);
          if (this.current(context)) {
            this.invalidateDirectories(paths, context);
            if (!context.watchQueued) {
              context.watchQueued = true;
              cx.timer.after(150, cx => {
                context.watchQueued = false;
                if (this.current(context)) { this.refreshSearch(cx); this.refresh(cx); }
              });
            }
          }
        }
      }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && (this.viewer || key(context) === context.key);
  }

  invalidateDirectories(paths, context = this.context) {
    getCatalog()?.invalidate(context, paths);
    if (!context?.cache) return;
    const root = normalized(rootPath(context.cwd), context.windows);
    const changed = paths?.map(path => normalized(rootPath(path), context.windows));
    const all = !changed?.length || changed.includes(root);
    for (const path of new Set([...context.cache.keys(), ...context.reads.keys()])) {
      const folder = normalized(rootPath(joinPath(context.cwd, path)), context.windows);
      if (all || changed.some(full => full === folder || folder.startsWith(full + "/") || rootPath(full.slice(0, full.lastIndexOf("/"))) === folder)) {
        context.cache.delete(path);
        const request = context.reads.get(path);
        if (request) { request.invalidated = true; context.reads.delete(path); }
      }
    }
  }

  async readDirectory(path, context) {
    const catalog = getCatalog();
    if (catalog) {
      const items = await catalog.read(context, path, this);
      if (items !== null) return items;
    }
    return this.readDirectoryLocal(path, context);
  }

  async readDirectoryLocal(path, context) {
    const cached = context.cache.get(path);
    if (cached && Date.now() - cached.time < CACHE_MS) {
      context.cache.delete(path); context.cache.set(path, cached);
      return cached.items;
    }
    const inflight = context.reads.get(path);
    if (inflight) return inflight.promise;
    const request = {};
    request.promise = (async () => {
      try {
        const items = await directory(joinPath(context.cwd, path), context.on, context);
        if (!this.current(context)) return items;
        // A watcher may invalidate while a process is reading. Never publish
        // its old listing or let an older completion erase the replacement request.
        if (request.invalidated) return this.readDirectory(path, context);
        context.cache.delete(path); context.cache.set(path, { items, time: Date.now() });
        let used = [...context.cache.values()].reduce((sum, entry) => sum + Math.max(1, entry.items.length), 0);
        while (used > TOTAL) {
          const oldest = context.cache.keys().next().value;
          used -= Math.max(1, context.cache.get(oldest).items.length); context.cache.delete(oldest);
        }
        return items;
      } finally { if (context.reads.get(path) === request) context.reads.delete(path); }
    })();
    context.reads.set(path, request);
    return request.promise;
  }

  async loadFolder(path, context, cx) {
    const entries = await this.readDirectory(path, context);
    return this.applyFolder(path, entries, context, cx);
  }

  applyFolder(path, entries, context, cx) {
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    if (entries.length <= PER_FOLDER) {
      const directories = new Set(entries.filter(entry => entry.dir).map(entry => entry.name));
      const prefix = path ? path + "/" : "";
      for (const folder of [...this.folders]) {
        if (folder.startsWith(prefix) && folder !== path && !directories.has(folder.slice(prefix.length).split("/")[0])) {
          this.folders.delete(folder); this.entries.delete(folder); context.cache.delete(folder);
        }
      }
    }
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    const visible = entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    for (const item of visible) this.ensureHandle(`file-${path ? `${path}/` : ""}${item.name}`, cx);
    const changed = JSON.stringify(this.entries.get(path)) !== JSON.stringify(visible);
    this.entries.set(path, visible);
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
    return changed;
  }

  syncCatalog(cx) {
    const root = getCatalog()?.peek(this.context);
    if (!root) { this.cacheError = null; return; }
    this.cacheError = null;
    for (const path of ["", ...this.folders]) {
      const error = root.cache.get(path)?.error;
      if (error) { this.cacheError = `Cannot refresh folder; showing cached files: ${error}`; break; }
    }
    if (root.version !== this.catalogVersion) {
      this.catalogVersion = root.version;
      for (const path of ["", ...this.folders]) {
        const entry = root.cache.get(path);
        if (entry?.items && !entry.stale && this.catalogApplied.get(path) !== entry) {
          this.applyFolder(path, entry.items, this.context, cx); this.catalogApplied.set(path, entry);
        }
      }
      if (this.query.value().trim()) this.refreshSearch(cx);
    }
    if (root.gitVersion !== this.catalogGitVersion) {
      this.catalogGitVersion = root.gitVersion;
      this.refreshSearch(cx); this.refresh(cx);
    }
  }

  refresh(cx) {
    if (this.viewer) {
      if (this.viewerChecking || this.busy || !this.file || this.snapshot === undefined || !this.code) return;
      const context = this.context, version = this.openVersion, snapshot = this.snapshot, file = this.file;
      this.viewerChecking = true;
      cx.spawn(async cx => {
        try {
          const text = await readTextFile(joinPath(context.cwd, file), { on: context.on });
          if (this.current(context) && version === this.openVersion && !this.busy && this.snapshot === snapshot && text !== snapshot) {
            this.external = true; this.savePaused = true; this.persist(); this.note = "File changed or was deleted on disk.";
          }
        } catch (e) {
          if (this.current(context) && version === this.openVersion) { this.external = true; this.savePaused = true; this.persist(); this.note = `Cannot check file: ${e}`; }
        } finally { this.viewerChecking = false; cx.notify(); }
      });
      return;
    }
    const { cwd, on } = location(this.context), next = key(this.context);
    for (const draft of this.drafts()) { this.ensureHandle(`restore-${draft.key}`, cx); this.ensureHandle(`discard-${draft.key}`, cx); }
    if (next !== this.context?.key) {
      const hadDraft = this.dirty();
      if (hadDraft) this.persist();
      if (hadDraft && this.draftError) { this.contextChanged = true; return; }
      this.contextChanged = false; this.searchVersion++; this.searching = false; this.searchQueued = false; this.openVersion++;
      getCatalog()?.cancel(this);
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: hadDraft ? null : this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on, windows: !on && window()?.platform === "windows", cache: new Map(), reads: new Map() }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.missing = new Set(); this.draftKey = null; this.show(null); this.watched = null; this.error = null; this.statusError = null; this.limited = false;
      this.catalogApplied.clear(); this.catalogVersion = -1; this.catalogGitVersion = getCatalog()?.peek(this.context)?.gitVersion || 0;
      this.indexMarks();
      for (const draft of this.drafts()) { this.ensureHandle(`restore-${draft.key}`, cx); this.ensureHandle(`discard-${draft.key}`, cx); }
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
      if (this.query.value()) this.search(cx);
    }
    if (this.query.value().trim() && Date.now() - this.searchStarted >= 10000) this.refreshSearch(cx);
    if (!cwd) return;
    if (this.loading) { this.context.refreshAgain = true; return; }
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          if (path && !this.folders.has(path)) continue;
          if (await this.loadFolder(path, context, cx)) cx.notify();
        }
        if (on) {
          const probe = await exec("sh", ["-c", "uname -s"], { on }).catch(() => null);
          if (probe?.code === 0) context.windows = /^(MINGW|MSYS|CYGWIN)/i.test(probe.stdout.trim());
          else {
            const win = await exec("cmd", ["/c", "ver"], { on }).catch(() => null);
            context.windows = win?.code === 0;
          }
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {}, missing = new Set(); let statusError;
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: top.stdout.trim(), on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, 1000)) {
            if (!this.current(context)) return;
            const xy = entry.slice(0, 2);
            const full = joinPath(top.stdout.trim(), entry.slice(3));
            marks[full] = xy.includes("U") || xy === "AA" || xy === "DD" ? "U" : xy.includes("D") ? "D" : xy === "??" || xy.includes("A") ? "A" : "M";
            if (marks[full] === "D" || xy === "DD") {
              try { if (await readTextFile(full, { on }) === null) missing.add(full); }
              catch { /* Failure to read does not prove a file is absent. */ }
            }
          }
          if (status?.code !== 0) statusError = `Git status unavailable: ${status?.stderr || "error"}`;
          else statusError = status.stdout.split("\0").filter(Boolean).length > 1000 ? "Git status limited to 1,000 changes" : null;
        } else statusError = "Git status unavailable: not a repository or Git error";
        if (!this.current(context)) return;
        const changedMarks = JSON.stringify(this.marks) !== JSON.stringify(marks);
        this.marks = marks; this.missing = missing; this.statusError = statusError; this.error = null; this.watch(cwd, cx);
        this.indexMarks();
        if (changedMarks) this.refreshSearch(cx);
        if (this.file && this.snapshot !== undefined && this.code && !this.busy) {
          const version = this.openVersion, file = this.file, snapshot = this.snapshot;
          try { const text = await readTextFile(`${cwd}/${file}`, { on }); if (this.current(context) && version === this.openVersion && !this.busy && this.snapshot === snapshot && text !== snapshot) { this.external = true; this.savePaused = true; this.persist(); } }
          catch (e) { if (this.current(context) && version === this.openVersion) { this.external = true; this.note = `Cannot check file: ${e}`; } }
        }
      } catch (e) { if (this.current(context)) { this.error = String(e); this.marks = {}; this.missing = new Set(); this.indexMarks(); this.statusError = `Git status unavailable: ${e}`; } }
      finally {
        if (this.context === context) {
          this.loading = false;
          if (context.refreshAgain) { context.refreshAgain = false; this.refresh(cx); }
        }
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      getCatalog()?.hint(this.context, path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context, cx); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  request(path, cx) {
    if (!this.viewer && path) {
      const { space } = location(this.context);
      run("tab.new", { name: path.split("/").pop(), space, mod: "claude-files-261106", props: { file: path, root: this.root, on: this.on, space } });
      return;
    }
    if (this.busy) { this.note = "Wait for saving to finish."; cx.notify(); return; }
    if (this.dirty() && this.editable && !this.savePaused && !this.external) {
      this.nextFile = path; this.leaveAfterSave = true; this.save(cx); return;
    }
    if (this.dirty()) { this.persist(); if (this.draftError) { this.note = "Cannot retain draft; remain on this file."; cx.notify(); return; } }
    this.show(path, cx);
    cx.notify();
  }

  show(path, cx, draft) {
    const version = ++this.openVersion; this.saveVersion++; this.leaveAfterSave = false;
    this.code?.release(); this.code = null; this.draftKey = draft?.key ?? null; this.file = path; this.fileError = null;
    this.snapshot = undefined; this.editable = false; this.external = false; this.savePaused = false; this.note = null; this.mode = "raw";
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (version !== this.openVersion || !this.current(context)) return;
        if (text === null && !draft) { this.fileError = "This file is no longer available"; return; }
        if (text === null && draft) {
          this.snapshot = draft.snapshot; this.external = true; this.editable = !on && ![".mcp.json", ".claude/settings.json"].includes(path.replace(/\\/g, "/").toLowerCase());
          this.code = EditorState.new({ value: draft.text, readonly: !this.editable, font_family: settings().font_family, font_size: 12 });
          this.savePaused = true;
          this.code.on("change", (_e, cx) => { this.scheduleSave(cx); cx.notify(); });
          this.note = this.editable ? "Draft restored; the file was deleted. Saving will check the original snapshot." : "Draft restored; the file was deleted. This draft is read-only and retained.";
          return;
        }
        if (text.includes("\0")) { if (draft) this.restoreReadOnly(draft, "Disk file is binary. Draft is read-only and retained."); else this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.snapshot = draft ? draft.snapshot : text;
        this.external = Boolean(draft && text !== draft.snapshot);
        this.savePaused = this.external;
        const protectedFile = path.replace(/\\/g, "/").toLowerCase() === ".mcp.json" || path.replace(/\\/g, "/").toLowerCase() === ".claude/settings.json";
        this.editable = !on && text.length <= 400000 && !protectedFile;
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: !this.editable,
          value: draft ? draft.text : text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
        this.code.on("change", (_e, cx) => { this.scheduleSave(cx); cx.notify(); });
        if (draft && !this.external) this.scheduleSave(cx);
        this.note = draft && !this.editable ? `Unsaved draft restored in full; read-only because ${on ? "remote writes are unavailable" : protectedFile ? "the file is protected" : "the disk file exceeds the editing limit"}. Draft retained.` : on ? "Remote file: read-only; writes are local only" : protectedFile ? "Protected configuration: read-only" : text.length > 400000 ? "Preview truncated; editing disabled" : draft ? "Unsaved draft restored" : null;
      } catch (e) { if (version === this.openVersion && this.current(context)) { this.fileError = `Cannot read file (UTF-8, maximum 1 MiB): ${e}`; if (draft) this.restoreReadOnly(draft, `${this.fileError}. Draft is read-only and retained`); } }
      finally { cx.notify(); }
    });
  }

  restoreReadOnly(draft, note) {
    this.snapshot = draft.snapshot; this.external = true; this.editable = false;
    this.code = EditorState.new({ value: draft.text, readonly: true, font_family: settings().font_family, font_size: 12 });
    this.note = note;
  }

  save(cx) {
    if (!this.editable || !this.dirty() || this.busy || this.savePaused || this.external || this.contextChanged || !this.current(this.context)) return;
    const context = this.context, path = this.file, value = this.code.value(), snapshot = this.snapshot;
    this.busy = true; this.note = "Saving…";
    cx.spawn(async cx => {
      try {
        await writeTextFile(`${context.cwd}/${path}`, value, snapshot);
        if (this.context === context && this.file === path) { this.snapshot = value; this.external = false; this.note = "Saved"; this.persist(); }
      } catch (e) { if (this.context === context && this.file === path) { this.savePaused = true; this.external = true; this.leaveAfterSave = false; this.persist(); this.note = `Auto-save stopped; file changed or save failed. Draft retained: ${e}`; } }
      finally {
        this.busy = false;
        if (this.context === context && this.file === path && !this.savePaused) {
          if (this.dirty()) this.scheduleSave(cx);
          else if (this.leaveAfterSave) { this.leaveAfterSave = false; this.show(this.nextFile, cx); }
        } else if (this.dirty() && !this.savePaused && !this.external) this.scheduleSave(cx);
        cx.notify();
      }
    }); cx.notify();
  }

  discard(cx) {
    if (this.busy) { this.note = "Wait for saving to finish before discarding."; cx.notify(); return; }
    this.confirming = false; this.openVersion++; this.code?.release(); this.code = null; this.file = null; this.persist();
    if (this.contextChanged) { this.contextChanged = false; this.refresh(cx); } else this.show(this.nextFile, cx);
    cx.notify();
  }

  mark(path) {
    return this.markIndex.get(normalized(joinPath(this.root, path), this.context?.windows)) || "";
  }

  indexMarks() {
    this.markIndex = new Map(Object.entries(this.marks).map(([path, mark]) => [normalized(path, this.context?.windows), mark]));
    this.missingIndex = new Set([...this.missing].map(path => normalized(path, this.context?.windows)));
  }

  markColor(mark, t) { return mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked; }

  isMissing(path) {
    return this.missingIndex.has(normalized(joinPath(this.root, path), this.context?.windows));
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.mark(path);
      out.push(this.control(h_flex().h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7), `file-${path}`, (_e, cx) => entry.dir ? this.toggle(path, cx) : this.request(path, cx), t, false)
        .child(entry.dir ? svg(`mods/claude-files-261106/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/claude-files-261106/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(this.markColor(mark, t)).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (this.catalogService) { this.catalog.sync(cx); return div().size_full(); }
    if (!this.viewer && key(this.context) !== this.context?.key) this.refresh(cx);
    else this.contextChanged = false;
    if (!this.viewer) this.syncCatalog(cx);
    if (this.viewer) {
      const tab = focused()?.tab;
      if (tab) this.mode = shared(`files.editor.mode:${tab}`) || "raw";
    }
    const t = theme(), q = this.query.value().trim(), prefix = normalized(joinPath(this.root || "", ""), this.context?.windows);
    const deleted = [...this.missing].filter(p => normalized(p, this.context?.windows).startsWith(prefix)).map(p => p.slice(prefix.length));
    const drafts = this.drafts();
    const button = (id, text, action) => this.control(div().px(8).py(4).rounded(5), id, action, t).child(text);
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .when(!this.viewer, el => el.child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file) && !this.viewer, el => el.child(this.control(div().w(20).text_color(t.muted), "files-back", (_e, cx) => this.request(null, cx), t).child("←")))
        .child(div().font_semibold().child(this.viewer ? "Editor" : "Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child((this.file ?? this.root?.split(/[\\/]/).pop() ?? "") + (this.dirty() ? " •" : "")))))
      .when(this.contextChanged && this.draftError, el => el.child(div().p(8).text_color(t.blocked).child("Draft storage failed. Return to the original folder; keep this pane open.")))
      .when(!this.file && drafts.length > 0, el => el.child(v_flex().p(8).children(drafts.map(d => v_flex().child(div().child(`Recover draft: ${d.file} (${d.root})`)).child(h_flex()
        .child(button(`restore-${d.key}`, "Restore copy", (_e, cx) => {
          try {
            if (!localStorage.getItem(d.key)) { this.note = "Draft is no longer available"; cx.notify(); return; }
            const { space } = location(this.context);
            run("tab.new", { name: d.file.split("/").pop(), space, mod: "claude-files-261106", props: { file: d.file, root: d.root, on: d.on, space, draft: d } });
          } catch { this.draftError = true; cx.notify(); }
        }))
        .child(button(`discard-${d.key}`, "Discard draft", (_e, cx) => { try { localStorage.removeItem(d.key); } catch { this.draftError = true; } cx.notify(); })))))))
      .when(!this.file && this.draftError, el => el.child(div().p(8).text_color(t.blocked).child("Draft recovery storage failed or contains an unreadable draft.")))
      .when(!this.file, el => el.child(v_flex().flex_1().min_h(0)
        .child(div().mx(8).my(6).px(8).h(32).border_1().border_color(t.border).child(Input.new(this.query).h_full().text_size(12)))
        .child(div().px(10).text_size(11).text_color(t.dim).child("Hidden and ignored files included; repository metadata excluded. Search: 500 entries per folder, 5,000 total, depth 40; links may be followed."))
        .when(Boolean(this.statusError), e => e.child(div().p(8).text_size(11).text_color(t.dim).child(this.statusError)))
        .when(Boolean(this.cacheError), e => e.child(div().p(8).text_size(11).text_color(t.dim).child(this.cacheError)))
        .when(Boolean(this.note), e => e.child(div().p(8).text_color(t.blocked).child(this.note)))
        .child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
          .children(q ? this.results.map(path => h_flex().h(28).px(8).gap(8).when(!this.isMissing(path), e => this.control(e, `result-${path}`, (_e,cx) => this.request(path,cx), t, false)).child(div().flex_1().min_w(0).truncate().child(path + (this.isMissing(path) ? " (not available)" : ""))).child(div().text_color(this.markColor(this.mark(path), t)).child(this.mark(path)))) : this.rows("", 0, [], t))
          .when(q, e => e.child(div().p(8).text_size(11).text_color(t.dim).child(this.searching ? "Searching…" : (this.searchError || (!this.results.length ? "No matching files" : "")) + (this.searchLimited ? " · Search truncated" : ""))))
          .when(!q && deleted.length > 0, e => e.child(v_flex().child(div().p(8).text_color(t.dim).child("Missing paths (Git)")) .children(deleted.map(path => h_flex().id(`deleted-${path}`).h(28).px(8).gap(8).child(div().flex_1().min_w(0).truncate().child(path + " (not available)")).child(div().text_color(t.ansi1).child(this.mark(path)))))))
          .when(!q && (Boolean(this.error) || !this.entries.get("")?.length), e => e.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
          .when(this.limited, e => e.child(div().p(8).text_size(11).text_color(t.dim).child("Tree limited to 500 entries per folder and 5,000 total"))))))
      .when(Boolean(this.file), el => el.child(v_flex().flex_1().min_h(0)
        .when(!this.viewer, el => el.child(h_flex().px(8).items_center().child(button("raw", "Raw", (_e,cx) => { this.mode = "raw"; cx.notify(); })).child(button("content", "Content", (_e,cx) => { this.mode = "content"; cx.notify(); })).child(div().flex_1())))
        .when(Boolean(this.note) || this.external || this.draftError, e => e.child(div().p(8).text_size(11).text_color(t.blocked).child((this.external ? "Auto-save stopped. Draft retained. " : "") + (this.note ?? "") + (this.draftError ? " Draft recovery storage failed." : ""))))
        .when(this.external, e => e.child(h_flex().child(button("reload", "Discard and reload", (_e,cx) => { this.nextFile = this.file; this.discard(cx); })).child(button("keep", "Keep draft", (_e,cx) => { this.note = "Draft retained; auto-save remains stopped."; cx.notify(); }))))
        .child(this.code ? this.mode === "raw" ? Editor.new(this.code).flex_1().min_h(0) : /\.(md|markdown)$/i.test(this.file) ? TextView.markdown("files-content", this.code.value()).scrollable(true).flex_1().min_h(0) : div().p(12).text_color(t.dim).child("No Content renderer for this format. Select Raw.") : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"))));
  }
}
