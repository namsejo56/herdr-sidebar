import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Popover, Popup, Progress, ProgressTrack, ProgressIndicator } from "gpui-base";
import { spaces, panes, terminals, focused, readTextFile, exec, theme, openOverlay, props } from "herdr";
import { connection, setConnectionVersion } from "./mcp-connection.js";
import McpDetails from "./mcp-details.js";
import { readSession, sessionRevision, permissionLabel, invalidateSessionOptions } from "./session-context.js";
import SessionControls from "./session-controls.js";
const CHECK_INTERVAL = 10000, QUOTA_INTERVAL = 60000, MAX_CONTEXTS = 32;
const contexts = new Map(), quotas = new Map(), sessions = new Map();
const SESSION_AGENTS = new Set(["codex", "claude-code"]);
const CLAUDE_PERMISSION_MODES = { default: "Default", acceptEdits: "Accept edits", plan: "Plan", auto: "Auto", dontAsk: "Don't ask", bypassPermissions: "Bypass permissions" };
function quotaLabel(minutes, reset, now = Date.now()) {
  const label = minutes === 300 ? "5h" : "7d";
  if (!Number.isFinite(reset) || reset <= 0 || !Number.isFinite(new Date(reset * 1000).getTime())) return label;
  const remaining = Math.max(0, Math.ceil((reset * 1000 - now) / 60000));
  const days = Math.floor(remaining / 1440), hours = Math.floor(remaining % 1440 / 60), mins = remaining % 60;
  const time = days ? `${days}d${hours ? ` ${hours}h` : ""}` : hours ? `${hours}h${mins ? ` ${mins}m` : ""}` : `${mins}m`;
  return `${label} (${time})`;
}
function sessionKey(current) {
  // Claude's bridge is keyed by terminal, and Claude animates its title while busy, so the title must not reset its cache or picker.
  if (current.agent === "claude-code") return JSON.stringify([current.machine, current.terminal, current.agent]);
  return JSON.stringify([current.machine, current.terminal, current.agent, current.cwd, current.sessionTitle?.split(" | ", 1)[0], current.duplicateTitle]);
}
function compactTokens(value) {
  if (value >= 999500) return `${Number((value / 1000000).toFixed(1))}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return `${Math.round(value)}`;
}

// Runs on the target machine. Only a digest leaves the process, never config values.
function codexConfigStamp() {
  const fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto");
  const hash = crypto.createHash("sha256");
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const system = process.platform === "win32" ? path.join(process.env.ProgramData || "C:/ProgramData", "OpenAI", "Codex") : "/etc/codex";
  const dirs = new Set([codexHome, system]);
  for (let dir = process.cwd();; dir = path.dirname(dir)) {
    dirs.add(path.join(dir, ".codex"));
    if (dir === path.dirname(dir)) break;
  }
  for (const dir of dirs) {
    hash.update(dir);
    let names;
    try { names = fs.readdirSync(dir).filter(name => name.endsWith(".toml")).sort(); }
    catch (e) { if (e.code === "ENOENT") continue; throw e; }
    for (const name of names) { hash.update(name); hash.update(fs.readFileSync(path.join(dir, name))); }
  }
  console.log(hash.digest("hex"));
}

function contextKey(current) { return JSON.stringify([current.space, current.machine, current.cwd, current.agent]); }
function projectStamp(raw) {
  let first = 2166136261, second = 5381;
  for (let i = 0; i < (raw?.length ?? 0); i++) {
    first = Math.imul(first ^ raw.charCodeAt(i), 16777619);
    second = Math.imul(second, 33) ^ raw.charCodeAt(i);
  }
  return `${first >>> 0}:${second >>> 0}`;
}
function cached(map, key) {
  let entry = map.get(key);
  if (!entry) entry = { entries: [], ready: false, started: false, checkedAt: 0, generation: 0, job: null, error: null };
  map.delete(key); map.set(key, entry);
  while (map.size > MAX_CONTEXTS) map.delete(map.keys().next().value);
  return entry;
}

function loadMcp(entry, current, force) {
  const generation = ++entry.generation;
  entry.started = true; entry.checkedAt = Date.now();
  const job = (async () => {
    try {
      const raw = await readTextFile(`${current.cwd}/.mcp.json`, { on: current.machine });
      const project = raw === null ? {} : JSON.parse(raw)?.mcpServers ?? {};
      if (!project || typeof project !== "object" || Array.isArray(project)) throw new Error();
      const names = new Set(Object.keys(project));
      let stamp = null, codexNames = entry.codexNames ?? [];
      if (current.agent === "codex") {
        try {
          const r = await exec("node", ["-e", `(${codexConfigStamp.toString()})()`], { cwd: current.cwd, on: current.machine, timeout: 10000 });
          if (r.code === 0 && /^[a-f0-9]{64}$/.test(r.stdout.trim())) stamp = r.stdout.trim();
        } catch { /* Native Codex installs may not have Node; compare CLI results on the next check. */ }
        if (force || !entry.ready || stamp === null || stamp !== entry.stamp) {
          const listed = await exec("codex", ["mcp", "list", "--json"], { cwd: current.cwd, on: current.machine, timeout: 10000 });
          if (listed.code !== 0) throw new Error();
          const parsed = JSON.parse(listed.stdout);
          if (!Array.isArray(parsed)) throw new Error();
          codexNames = parsed.filter(item => typeof item?.name === "string").map(item => item.name);
        }
        for (const name of codexNames) names.add(name);
      }
      if (entry.generation !== generation) return;
      const entries = [...names].sort();
      if (JSON.stringify(entries) !== JSON.stringify(entry.entries)) entry.entries = entries;
      entry.codexNames = codexNames; entry.stamp = stamp; entry.ready = true; entry.error = null;
      entry.connectionVersion = JSON.stringify([stamp, projectStamp(raw)]);
      setConnectionVersion(current, entry.connectionVersion);
    } catch {
      if (entry.generation === generation) entry.error = entry.ready ? "Could not update MCP configuration; showing cached servers." : "Could not read MCP configuration.";
    } finally { if (entry.generation === generation) entry.job = null; }
  })();
  entry.job = job;
  return job;
}
const CODEX_QUOTA = `import json, subprocess, threading, queue, sys
p=subprocess.Popen(["codex","app-server","--listen","stdio://"],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding="utf-8")
q=queue.Queue()
def read():
 for line in p.stdout:
  try: q.put(json.loads(line))
  except Exception: pass
threading.Thread(target=read,daemon=True).start()
def send(x):
 p.stdin.write(json.dumps(x)+"\\n"); p.stdin.flush()
def receive(i):
 while True:
  x=q.get(timeout=12)
  if x.get("id")==i: return x
try:
 send({"id":1,"method":"initialize","params":{"clientInfo":{"name":"herdr_inspector","version":"1.0"}}})
 if "result" not in receive(1): raise ValueError()
 send({"method":"initialized","params":{}})
 send({"id":2,"method":"account/rateLimits/read"})
 result=receive(2).get("result",{}).get("rateLimits") or {}
 out=[]
 for key in ("primary","secondary"):
  v=result.get(key)
  if isinstance(v,dict): out.append({"minutes":v.get("windowDurationMins"),"used":v.get("usedPercent"),"reset":v.get("resetsAt")})
 print(json.dumps(out))
except Exception: print("[]")
finally:
 if sys.platform == "win32":
  subprocess.run(["taskkill", "/pid", str(p.pid), "/t"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
 else: p.terminate()
 try: p.wait(timeout=2)
 except subprocess.TimeoutExpired:
  if sys.platform == "win32": subprocess.run(["taskkill", "/pid", str(p.pid), "/t", "/f"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
  else: p.kill()
  p.wait()
`;

function target() {
  const f = focused(), space = spaces().find(s => s.id === f?.space);
  const p = panes().find(p => f?.terminal && p.terminal === f.terminal) ?? (f?.terminal ? null : panes().find(p => p.pane === f?.pane));
  const all = terminals(), terminal = all.find(t => t.address === f?.terminal);
  const sessionTitle = terminal?.title ?? p?.title ?? "";
  const name = sessionTitle.split(" | ", 1)[0].trim();
  const duplicateTitle = !!name && all.filter(t => t.title?.split(" | ", 1)[0].trim() === name).length > 1;
  return { space: space?.id ?? f?.space ?? null, terminal: f?.terminal ?? null, cwd: f?.cwd ?? p?.cwd ?? null, machine: space?.machine ?? null, agent: p?.app ?? terminal?.report?.app ?? null, title: p?.program?.name ?? terminal?.program?.name ?? "Terminal", sessionTitle, duplicateTitle };
}
export default class Inspector extends View {
  init(p, cx) {
    const currentProps = { ...p, ...props() };
    this.popup = !!currentProps.server;
    if (this.popup) { this.details = new McpDetails(); this.details.init(currentProps, cx); return; }
    this.closed = false; this.entries = []; this.quota = []; this.connections = new Map(); this.healthJobs = new WeakSet(); this.sync(cx);
    this.quotaLabels = [300, 10080].map(minutes => quotaLabel(minutes, this.quota?.find(w => w.minutes === minutes)?.reset)).join("|");
    cx.timer.every(CHECK_INTERVAL, cx => {
      if (this.closed) return;
      this.sync(cx, false, true);
      const labels = [300, 10080].map(minutes => quotaLabel(minutes, this.quota?.find(w => w.minutes === minutes)?.reset)).join("|");
      if (labels !== this.quotaLabels) { this.quotaLabels = labels; cx.notify(); }
    });
  }
  close() { this.closed = true; this.dismissControl(); this.details?.close(); }
  dismissControl() { this.sessionControl?.close(); this.sessionControl = null; }
  setControl(field, current, session, open, cx) {
    if (this.closed) return;
    if (!open) {
      if (this.sessionControl?.field === field && this.sessionControl.current.session === session
        && sessionKey(this.sessionControl.current) === sessionKey(current)) this.dismissControl();
      cx.notify(); return;
    }
    if (this.closed || sessionKey(target()) !== sessionKey(current)) return;
    this.dismissControl();
    const picker = new SessionControls(); this.sessionControl = picker;
    picker.init({ ...current, control: field, session, state: this.session }, cx, cx => {
      if (this.sessionControl !== picker) return;
      this.dismissControl(); this.sync(cx); cx.notify();
    });
    cx.notify();
  }
  active(current) { return !this.closed && contextKey(target()) === contextKey(current); }
  refresh(cx, force = true) { this.sync(cx, force); }
  syncSession(cx, current, force, poll) {
    const key = sessionKey(current);
    this.session = null; this.sessionError = null; this.sessionLoading = false;
    if (!current.terminal || !SESSION_AGENTS.has(current.agent)) return;
    const entry = cached(sessions, key);
    if (force) { this.dismissControl(); invalidateSessionOptions(current, entry.snapshot?.session); }
    if (!entry.job && (force || !entry.started || entry.controlRevision !== sessionRevision() || (poll && Date.now() - entry.checkedAt >= CHECK_INTERVAL))) {
      entry.started = true; entry.checkedAt = Date.now(); entry.controlRevision = sessionRevision();
      entry.job = readSession(current).then(snapshot => { entry.snapshot = snapshot; entry.error = null; }, () => {
        entry.snapshot = null; entry.error = "Could not read session information. Try Refresh.";
      }).finally(() => { entry.job = null; });
    }
    this.session = entry.snapshot ?? null; this.sessionError = entry.error; this.sessionLoading = !!entry.job && !entry.snapshot;
    if (this.sessionControl && (this.sessionControl.current.session ?? null) !== (this.session?.session ?? null)) this.dismissControl();
    if (entry.job && this.sessionJob !== entry.job) {
      const job = entry.job; this.sessionJob = job;
      cx.spawn(async cx => {
        const before = JSON.stringify([this.session, this.sessionError, this.sessionLoading]);
        await job;
        if (this.closed || sessionKey(target()) !== key) return;
        this.syncSession(cx, target(), false, false);
        if (before !== JSON.stringify([this.session, this.sessionError, this.sessionLoading])) cx.notify();
      });
    }
  }
  sync(cx, force = false, poll = false) {
    if (this.closed) return;
    const current = target(), key = contextKey(current);
    this.current = current; this.key = key;
    if (this.sessionControl && sessionKey(this.sessionControl.current) !== sessionKey(current)) this.dismissControl();
    if (!current.cwd) { this.syncSession(cx, current, force, poll); this.entries = []; this.quota = []; this.loading = false; this.error = null; return; }
    const entry = cached(contexts, key);
    if (force) entry.forceHealth = true;
    if (force || !entry.started || (poll && Date.now() - entry.checkedAt >= CHECK_INTERVAL)) {
      if (force || !entry.job) loadMcp(entry, current, force);
    }
    this.entries = entry.entries; this.loading = !entry.ready && !!entry.job; this.error = entry.error;
    this.observe(cx, entry.job, key, "mcpJob");
    this.syncSession(cx, current, force, poll);
    if (this.connectionKey !== key) { this.connections = new Map(); this.connectionKey = key; }
    this.connectionVersion = entry.connectionVersion;
    if (entry.ready && !entry.job && !entry.error) {
      this.connections = new Map(this.entries.map(name => [name, connection(current, name, entry.connectionVersion, !!entry.forceHealth, this)]));
      entry.forceHealth = false;
      for (const check of this.connections.values()) {
        const job = check.job;
        if (!job || this.healthJobs.has(job)) continue;
        this.healthJobs.add(job);
        cx.spawn(async cx => { await job; if (!this.closed && contextKey(target()) === key) cx.notify(); });
      }
    }
    this.quota = [];
    if (current.agent === "claude-code") { this.quota = this.session?.quota ?? []; return; }
    if (current.agent !== "codex") return;
    const quota = cached(quotas, JSON.stringify([current.space, current.machine]));
    if (!quota.job && (force || !quota.started || (poll && Date.now() - quota.checkedAt >= QUOTA_INTERVAL))) {
      quota.started = true; quota.checkedAt = Date.now();
      quota.job = (async () => {
        try {
          const r = await exec("python", ["-c", CODEX_QUOTA], { cwd: current.cwd, on: current.machine, timeout: 35000 });
          if (r.code !== 0) return;
          const parsed = JSON.parse(r.stdout);
          if (Array.isArray(parsed)) quota.entries = parsed;
        } catch { /* Keep the previous account snapshot on a transient failure. */ }
        finally { quota.job = null; }
      })();
    }
    this.quota = quota.entries;
    this.observe(cx, quota.job, key, "quotaJob");
  }
  observe(cx, job, key, field) {
    if (!job || this[field] === job) return;
    this[field] = job;
    cx.spawn(async cx => {
      await job;
      if (this.closed || contextKey(target()) !== key) return;
      const before = JSON.stringify([this.entries, this.quota, this.loading, this.error]);
      this.sync(cx);
      if (before !== JSON.stringify([this.entries, this.quota, this.loading, this.error])) cx.notify();
    });
  }
  toggleSection(key, cx) {
    this.collapsed ??= {};
    this.collapsed[key] = !this.collapsed[key];
    if (key === "session" && this.collapsed[key]) this.dismissControl();
    cx.notify();
  }
  copySession(id, cx) {
    cx.stop_propagation(); cx.write_to_clipboard(id);
    const generation = (this.copyGeneration ?? 0) + 1;
    this.copyGeneration = generation; this.copiedSession = id;
    cx.timer.after(1600, cx => {
      if (this.closed || this.copyGeneration !== generation) return;
      this.copiedSession = null; cx.notify();
    });
    cx.notify();
  }
  section(t, title, key, content) {
    const collapsed = !!this.collapsed?.[key];
    return v_flex().gap(4)
      .child(h_flex().id(`section-${key}`).pt(14).pb(4).gap(6).items_center().cursor_pointer()
        .accessibility_label(`${collapsed ? "Expand" : "Collapse"} ${title.toLowerCase()}`)
        .on_click((_e,cx) => this.toggleSection(key,cx))
        .child(div().flex_1().text_size(11).font_semibold().text_color(t.dim).child(title))
        .child(div().text_size(10).text_color(t.dim).child(collapsed ? "▸" : "▾")))
      .when(!collapsed, el => el.child(content()));
  }
  render(cx) {
    const t = theme();
    if (this.popup) return this.details.render();
    if (!this.popup && cx) this.sync(cx);
    return v_flex().id("context-inspector").size_full().min_w(0).bg(t.chrome).p(12).gap(4).text_size(13).overflow_y_scrollbar()
      .child(h_flex().items_center().child(div().flex_1().font_semibold().text_color(t.foreground).child("Context & MCP"))
        .child(div().id("refresh").cursor_pointer().text_color(t.muted).on_click((_e,cx) => this.refresh(cx)).child("Refresh")))
      .child(div().pt(14).pb(4).text_size(11).font_semibold().text_color(t.dim).child("FOCUSED TERMINAL"))
      .child(div().truncate().text_color(t.foreground).child(this.current?.title ?? "No terminal focused"))
      .child(div().truncate().text_color(t.muted).tooltip(this.current?.cwd ?? "No folder").child(this.current?.cwd ?? "No folder available"))
      .child(this.section(t,"SESSION CONTEXT","session",() => this.sessionContent(t)))
      .child(this.section(t,"ACCOUNT USAGE","account",() => this.accountContent(t)))
      .child(this.section(t,"MCP SERVERS","mcp",() => this.mcpContent(t)));
  }
  accountContent(t) {
    return v_flex().gap(4)
      .child(div().text_color(t.dim).child(this.current?.agent === "codex" ? "Codex account on this machine; may differ from terminal account."
        : this.current?.agent === "claude-code" ? "Claude account for this session." : "Account data unavailable for this agent."))
      .children([300, 10080].map(minutes => {
        const w = this.quota?.find(x => x.minutes === minutes);
        const label = quotaLabel(minutes, w?.reset);
        const valid = Number.isFinite(w?.used);
        const used = valid ? Math.max(0, Math.min(100, w.used)) : null;
        const reset = Number.isFinite(w?.reset) && w.reset > 0 ? new Date(w.reset * 1000) : null;
        return v_flex().gap(5).pt(6)
          .child(h_flex().items_center()
            .child(div().flex_1().text_color(t.foreground).child(label))
            .child(div().text_color(valid ? t.foreground : t.dim).child(valid ? `${w.used}% used` : "Unavailable")))
          .when(valid, el => el.child(Progress.new(`quota-${minutes}`).w_full().value(used).accessibility_label(`${label} usage`)
            .child(ProgressTrack.new().w_full().h(6).rounded(3).bg(t.raised)
              .child(ProgressIndicator.new().w(`${used}%`).h_full().rounded(3).bg(t.accent)))))
          .when(!!reset && Number.isFinite(reset.getTime()), el => el.child(div().text_size(11).text_color(t.dim).child(`Resets ${reset.toLocaleString()}`)));
      }));
  }
  mcpContent(t) {
    return v_flex().gap(4)
      .child(div().text_size(11).text_color(t.dim).child("Separate connection checks; active session status unavailable."))
      .when(this.loading, el => el.child(div().text_color(t.dim).child("Reading configuration…")))
      .when(!!this.error, el => el.child(div().text_color(t.muted).child(this.error)))
      .when(!this.loading && !this.error && !this.entries.length, el => el.child(div().text_color(t.dim).child("No servers found in supported configuration.")))
      .children(this.entries.map((name, i) => h_flex().id(`server-${i}`).h(32).px(6).rounded(6).items_center().cursor_pointer().hover(s => s.bg(t.hover))
        .on_click(() => openOverlay({ mod: "context-inspector-261109", kind: "dialog", width: 500, height: 580, props: { server: name, space: this.current.space, version: this.connectionVersion, cwd: this.current.cwd, machine: this.current.machine, agent: this.current.agent, terminal: this.current.terminal } }))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(name))
        .child(div().text_size(11).text_color(this.connections?.get(name)?.result?.status === "connected" ? t.accent : t.dim)
          .child(this.connections?.get(name)?.job ? "Checking…" : this.connections?.get(name)?.result?.health ?? "Not checked"))));
  }
  sessionContent(t) {
    const snapshot = this.session ?? {};
    const approval = snapshot.approvalPolicy === "never" ? "Never ask" : snapshot.approvalPolicy === "on-request" ? "Ask when needed" : snapshot.approvalPolicy ? "Custom approvals" : null;
    const current = { ...this.current }, claude = current.agent === "claude-code";
    const canChange = control => !!current.terminal && !!current.cwd && (current.agent === "codex"
      || (claude && !!snapshot.session && (control === "model" || control === "effort") && !!snapshot.choices?.[control]?.length));
    const row = (label, value, control = null) => {
      const enabled = !!control && canChange(control), open = enabled && this.sessionControl?.field === control;
      const trigger = v_flex().gap(2).pt(4).min_w(0)
        .when(enabled, el => el.id(`session-${control}`).cursor_pointer().rounded(4).hover(s => s.bg(t.hover)))
        .child(div().text_size(11).text_color(t.dim).child(label))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).text_color(enabled ? t.accent : t.foreground).child(value))
          .when(enabled, el => el.child(div().text_size(10).text_color(t.muted).child(open ? "▴" : "▾"))));
      if (!enabled) return trigger;
      return Popover.new(`session-dropdown-${control}`).open(!!open).anchor("top_right")
        .accessibility_label(`${label} settings`).overlay_closable(true)
        .on_open_change((open, cx) => this.setControl(control, current, snapshot.session, open, cx))
        .trigger(trigger).content(open ? this.sessionControl.render() : div());
    };
    const percent = Number.isFinite(snapshot.contextPercent) ? Math.max(0, Math.min(100, snapshot.contextPercent)) : null;
    const title = current.sessionTitle?.split(" | ", 1)[0].trim() || "Untitled session";
    const contextWindow = Number.isFinite(snapshot.contextWindow) && snapshot.contextWindow > 0 ? snapshot.contextWindow : null;
    const reportedTokens = contextWindow !== null && Number.isFinite(snapshot.contextTokens) && snapshot.contextTokens >= 0;
    const ratio = contextWindow === null ? null : reportedTokens ? `${compactTokens(snapshot.contextTokens)}/${compactTokens(contextWindow)}`
      : percent !== null ? `${compactTokens(contextWindow * percent / 100)}/${compactTokens(contextWindow)}` : null;
    const copied = !!snapshot.session && this.copiedSession === snapshot.session;
    if (claude && (snapshot.bridgeMissing || snapshot.bridgeEnded)) return v_flex().gap(4)
      .child(div().id("session-title").font_semibold().text_color(t.foreground).truncate().tooltip(title).child(title))
      .child(div().id("bridge-missing").text_size(11).text_color(t.dim).child(snapshot.bridgeMissing
        ? "Install the herdr-bridge Claude mod to see session details." : "Claude is not running in this terminal."));
    return v_flex().gap(4)
      .child(div().id("session-title").font_semibold().text_color(t.foreground).truncate().tooltip(title).child(title))
      .when(!!snapshot.session, el => el.child(h_flex().items_center().gap(6).min_w(0)
        .child(div().id("session-id").flex_1().min_w(0).text_size(11).text_color(t.muted).truncate().tooltip(snapshot.session).child(snapshot.session))
        .child(Popup.new("session-copy-feedback", h_flex().id("copy-session-id").size(24).flex_none().rounded(4).items_center().justify_center().cursor_pointer().hover(s => s.bg(t.hover))
          .accessibility_label("Copy session ID").when(!copied, el => el.tooltip("Copy session ID"))
          .on_click((_e,cx) => this.copySession(snapshot.session,cx))
          .child(svg("mods/context-inspector-261109/copy.svg").size(14).text_color(t.muted)))
          .size(24).flex_none().anchor("top_right")
          .when(copied, el => el.content(div().id("session-copy-confirmation").px(8).py(4).rounded(4).bg(t.popover)
            .border_1().border_color(t.border).text_size(11).text_color(t.foreground).child("coppied"))))))
      .when(this.sessionLoading, el => el.child(div().text_color(t.dim).child("Reading session…")))
      .when(!!this.sessionError, el => el.child(div().text_color(t.muted).child(this.sessionError)))
      .child(row("Model", snapshot.model ?? "Unavailable", "model"))
      .child(row("Effort", snapshot.effort ?? "Unavailable", "effort"))
      .when(percent !== null, el => el.child(div().pt(4).text_size(11).text_color(t.dim).child("Context"))
        .child(h_flex().items_center().gap(6)
          .child(div().flex_1().text_color(t.foreground).child(`${percent}% used`))
          .when(!!ratio, el => el.child(div().id("context-token-ratio").text_size(11).text_color(t.muted)
            .tooltip(reportedTokens ? "Context tokens reported by Claude." : "Approximate tokens, based on the displayed context percentage.").child(ratio))))
        .child(Progress.new("session-context-usage").w_full().value(percent).accessibility_label("Session context usage")
          .child(ProgressTrack.new().w_full().h(6).rounded(3).bg(t.raised)
            .child(ProgressIndicator.new().w(`${percent}%`).h_full().rounded(3).bg(t.accent)))))
      .when(claude, el => el.child(row("Permission mode", CLAUDE_PERMISSION_MODES[snapshot.permission] ?? snapshot.permission ?? "Unavailable")))
      .when(!claude, el => el.child(row("Mode", snapshot.mode === "default" ? "Default" : snapshot.mode === "plan" ? "Plan" : "Unavailable", "mode"))
        .child(row("Permissions", `${permissionLabel(snapshot.permission)}${approval ? ` · ${approval}` : ""}`, "permissions")))
      .when(!!snapshot.controlError, el => el.child(div().text_size(11).text_color(t.dim).child("Live controls unavailable; showing last reported settings.")))
      .when(!this.sessionLoading && !this.sessionError && percent === null, el => el.child(div().text_size(11).text_color(t.dim)
        .child(this.current?.agent === "codex" ? "Context usage unavailable; no reported token data for this session."
          : claude ? "Context usage appears after Claude's next response." : "Session information unavailable for this agent.")));
  }
}
