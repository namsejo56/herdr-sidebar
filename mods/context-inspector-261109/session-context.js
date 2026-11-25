import { hc, exec, readTextFile, appHome } from "herdr";

let reader, controlsReader, revision = 0;
const optionContexts = new Map(), catalogContexts = new Map(), MAX_OPTION_CONTEXTS = 32;
function optionScope(current) { return JSON.stringify([current.machine ?? null, current.cwd, current.agent]); }
function optionKey(current, session) { return JSON.stringify([optionScope(current), session]); }
function optionGroup(field) { return field === "effort" ? "model" : field; }
function optionContext(current, session, create = true) {
  const key = optionKey(current, session);
  let entry = optionContexts.get(key);
  if (!entry && !create) return null;
  entry ??= { key, scope: optionScope(current), state: null, version: 0 };
  optionContexts.delete(key); optionContexts.set(key, entry);
  while (optionContexts.size > MAX_OPTION_CONTEXTS) optionContexts.delete(optionContexts.keys().next().value);
  return entry;
}
export function cachedSessionOptions(current, session, field) {
  if (current.agent === "claude-code") {
    let snapshot;
    try { snapshot = bridgeSnapshots.get(JSON.stringify([current.machine ?? null, bridgeKey(current.terminal)])); } catch { return null; }
    return snapshot && (field === "model" || field === "effort") ? { state: snapshot, choices: bridgeChoices(snapshot, field) } : null;
  }
  const entry = catalogContexts.get(optionScope(current)), group = optionGroup(field);
  return entry?.catalogs.has(group) ? { state: optionContext(current, session, false)?.state ?? null, choices: entry.catalogs.get(group) } : null;
}
export function invalidateSessionOptions(current, session = null) {
  catalogContexts.delete(optionScope(current));
  if (session) { optionContexts.delete(optionKey(current, session)); return; }
  const scope = optionScope(current);
  for (const [key, entry] of optionContexts) if (entry.scope === scope) optionContexts.delete(key);
}
export function permissionLabel(id) {
  return ({ ":read-only": "Read only", ":workspace": "Workspace", ":danger-full-access": "Full access" })[id] ?? id ?? "Unavailable";
}
export function sessionRevision() { return revision; }

// Claude Code publishes through the herdr-bridge Claude mod: <home>/.claude/herdr-bridge/<terminal>.json on the terminal's machine.
const BRIDGE_KEY = /^[A-Za-z0-9_-]+$/, BRIDGE_POLL_MS = 1000, BRIDGE_APPLY_MS = 30000, BRIDGE_WINDOWS = { five_hour: 300, seven_day: 10080 };
const BRIDGE_READ = `import pathlib,sys
p=pathlib.Path.home()/".claude"/"herdr-bridge"/(sys.argv[1]+".json")
try: sys.stdout.buffer.write(p.read_bytes())
except FileNotFoundError: sys.stdout.write("null")`;
const BRIDGE_WRITE = `import json,os,pathlib,sys,time
d=pathlib.Path.home()/".claude"/"herdr-bridge"
d.mkdir(parents=True,exist_ok=True)
r=json.loads(sys.argv[2]); r["createdAt"]=int(time.time()*1000)
t=d/(sys.argv[1]+".request.json.tmp")
t.write_text(json.dumps(r),encoding="utf-8")
os.replace(t,d/(sys.argv[1]+".request.json"))
sys.stdout.write("ok")`;
const bridgeSnapshots = new Map();
export function bridgeKey(terminal) {
  const key = String(terminal ?? "").split("/").pop();
  if (!BRIDGE_KEY.test(key)) throw new Error("Unsupported terminal address.");
  return key;
}
function finite(value) { return Number.isFinite(value) ? value : undefined; }
function text(value) { return typeof value === "string" && value ? value : undefined; }
function list(value) { return Array.isArray(value) ? value.filter(item => typeof item === "string" && item) : []; }
export function bridgeQuota(rateLimits) {
  return (Array.isArray(rateLimits) ? rateLimits : []).filter(w => BRIDGE_WINDOWS[w?.kind] && Number.isFinite(w.percentUsed)).map(w => {
    const reset = Date.parse(w.resetsAt);
    return { minutes: BRIDGE_WINDOWS[w.kind], used: w.percentUsed, reset: Number.isFinite(reset) ? Math.floor(reset / 1000) : null };
  });
}
function bridgeSession(s) {
  const last = s.lastRequest && typeof s.lastRequest === "object" && typeof s.lastRequest.id === "string" ? s.lastRequest : null;
  return {
    session: text(s.sessionId), model: text(s.model), effort: text(s.effort), permission: text(s.permissionMode),
    contextPercent: finite(s.context?.percent), contextWindow: finite(s.context?.window), contextTokens: finite(s.context?.tokens),
    quota: bridgeQuota(s.rateLimits), choices: { model: list(s.choices?.model), effort: list(s.choices?.effort) },
    lastRequest: last && { id: last.id, ok: typeof last.ok === "boolean" ? last.ok : null, error: text(last.error) ?? null },
    updatedAt: finite(s.updatedAt), bridge: true,
  };
}
async function readBridge(current) {
  const key = bridgeKey(current.terminal), cacheKey = JSON.stringify([current.machine ?? null, key]);
  // -I and no project cwd: a repo's own json.py or pathlib.py must never be imported by the reader.
  const result = await exec("python", ["-I", "-c", BRIDGE_READ, key], { on: current.machine, timeout: 10000 });
  if (result.code !== 0) {
    if (bridgeSnapshots.has(cacheKey)) return bridgeSnapshots.get(cacheKey);
    throw new Error("Could not read the herdr-bridge snapshot.");
  }
  let raw;
  try { raw = JSON.parse(result.stdout); } catch (error) {
    // The mod rewrites the file in place; a read that lands mid-write keeps the last whole snapshot.
    if (bridgeSnapshots.has(cacheKey)) return bridgeSnapshots.get(cacheKey);
    throw error;
  }
  if (raw === null) { bridgeSnapshots.delete(cacheKey); return { bridgeMissing: true }; }
  if (raw?.ended === true && raw.version === 1 && raw.terminal === key) { bridgeSnapshots.delete(cacheKey); return { bridgeEnded: true }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1 || raw.terminal !== key) throw new Error("Unsupported herdr-bridge snapshot.");
  const snapshot = bridgeSession(raw);
  bridgeSnapshots.delete(cacheKey); bridgeSnapshots.set(cacheKey, snapshot);
  while (bridgeSnapshots.size > MAX_OPTION_CONTEXTS) bridgeSnapshots.delete(bridgeSnapshots.keys().next().value);
  return snapshot;
}
function bridgeChoices(snapshot, field) {
  return (snapshot.choices?.[field] ?? []).map(id => ({ id, name: id }));
}
async function controlBridge(current, session, operation, field, value) {
  if (field !== "model" && field !== "effort") throw new Error("Only Model and Effort can be changed for Claude.");
  if (operation === "options") {
    const snapshot = await readBridge(current);
    if (snapshot.bridgeMissing) throw new Error("Install the herdr-bridge Claude mod to change settings.");
    if (snapshot.bridgeEnded) throw new Error("Claude is not running in this terminal.");
    return { choices: bridgeChoices(snapshot, field), state: snapshot };
  }
  if (operation !== "update") throw new Error("Unsupported Claude session operation.");
  if (!session) throw new Error("Session not identified yet.");
  const id = `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const written = await exec("python", ["-I", "-c", BRIDGE_WRITE, bridgeKey(current.terminal),
    JSON.stringify({ version: 1, id, sessionId: session, field, value })], { on: current.machine, timeout: 10000 });
  if (written.code !== 0 || written.stdout.trim() !== "ok") throw new Error("Could not send the change to Claude.");
  for (const deadline = Date.now() + BRIDGE_APPLY_MS; Date.now() < deadline;) {
    await new Promise(resolve => setTimeout(resolve, BRIDGE_POLL_MS));
    let snapshot;
    try { snapshot = await readBridge(current); } catch { continue; }
    const last = snapshot.lastRequest;
    if (last?.id !== id || last.ok === null) continue;
    if (!last.ok) throw new Error(last.error ?? "Claude rejected the change.");
    if (field === "effort" && snapshot.effort !== value) continue;
    revision++;
    return { state: snapshot, verified: true };
  }
  throw new Error("Claude has not applied the change yet; it applies when Claude is idle.");
}
async function requestSession(current, session, operation, field, value, expected) {
  controlsReader ??= await readTextFile(`${appHome()}/mods/context-inspector-261109/session-controls.py`);
  if (!controlsReader) throw new Error("Session controls unavailable.");
  const result = await exec("python", ["-c", controlsReader, JSON.stringify({
    session, cwd: current.cwd, operation, field, value, expected,
  })], { cwd: current.cwd, on: current.machine, timeout: 12000 });
  if (result.code !== 0) throw new Error("Could not access session controls.");
  const response = JSON.parse(result.stdout);
  if (response.error) throw new Error(response.error);
  if (operation !== "options" && (!response.state || typeof response.state !== "object")) throw new Error("Invalid session settings.");
  if (operation === "options" && !Array.isArray(response.choices)) throw new Error("Invalid session options.");
  if (operation === "update" && !response.verified) throw new Error("Session update could not be verified.");
  return response;
}
export async function controlSession(current, session, operation = "read", field = null, value = null, expected = null) {
  if (current.agent === "claude-code" && current.terminal) return controlBridge(current, session, operation, field, value);
  if (current.agent !== "codex" || !current.terminal || !current.cwd || (operation !== "options" && !session)) throw new Error("Select a Codex session first.");
  const group = optionGroup(field);
  if (operation === "options") {
    const cached = cachedSessionOptions(current, session, field);
    if (cached) return cached;
    const scope = optionScope(current);
    let entry = catalogContexts.get(scope);
    if (!entry) {
      entry = { catalogs: new Map(), jobs: new Map() };
      catalogContexts.set(scope, entry);
    }
    catalogContexts.delete(scope); catalogContexts.set(scope, entry);
    while (catalogContexts.size > MAX_OPTION_CONTEXTS) catalogContexts.delete(catalogContexts.keys().next().value);
    let job = entry.jobs.get(group);
    if (!job) {
      job = requestSession(current, null, operation, field).then(response => {
        if (catalogContexts.get(scope) === entry) entry.catalogs.set(group, response.choices);
        return response.choices;
      });
      entry.jobs.set(group, job);
    }
    try {
      const choices = await job;
      return { choices, state: optionContext(current, session, false)?.state ?? null };
    } finally { if (entry.jobs.get(group) === job) entry.jobs.delete(group); }
  }
  const entry = optionContext(current, session), version = entry.version;
  const job = (async () => {
    const response = await requestSession(current, session, operation, field, value, expected);
    if (operation === "update") revision++;
    if (optionContexts.get(entry.key) !== entry) return response;
    if (operation === "update" || entry.version === version) { entry.state = response.state; entry.version++; }
    return operation === "update" ? response : { ...response, state: entry.state };
  })();
  return job;
}
export async function readSession(current) {
  if (current.agent === "claude-code" && current.terminal) return readBridge(current);
  if (current.agent !== "codex" || !current.terminal) return {};
  const screen = await hc(["read", current.terminal, "--json", "--lines", "0"]);
  if (screen.code !== 0) throw new Error("Could not read terminal status.");
  const text = JSON.parse(screen.stdout)?.text;
  if (typeof text !== "string") throw new Error("Terminal status unavailable.");
  const lines = text.split(/\r?\n/);
  const status = lines.filter(line => /^\s*Session:\s*[a-f0-9-]{36}\s*$/i.test(line)).slice(-2);
  const footer = lines.slice(-8).filter(line => /\bContext\s+\d+(?:\.\d+)?%|\d+(?:\.\d+)?%\s+context left|^\s*(GPT-[\w.-]+|o\d[\w.-]*)\s/i.test(line));
  reader ??= await readTextFile(`${appHome()}/mods/context-inspector-261109/session-context.py`);
  if (!reader) throw new Error("Session reader unavailable.");
  const result = await exec("python", ["-c", reader, JSON.stringify({
    agent: current.agent, cwd: current.cwd, title: current.sessionTitle,
    duplicateTitle: current.duplicateTitle, screen: [...status, ...footer].map(line => line.slice(0, 1000)).join("\n"),
  })], { cwd: current.cwd, on: current.machine, timeout: 10000 });
  if (result.code !== 0) throw new Error("Could not read session metadata.");
  const snapshot = JSON.parse(result.stdout);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Invalid session metadata.");
  if (snapshot.session) {
    try {
      const response = await controlSession(current, snapshot.session);
      Object.assign(snapshot, response.state, { controlsAvailable: true });
    } catch (error) { snapshot.controlError = String(error.message); }
  }
  return snapshot;
}
