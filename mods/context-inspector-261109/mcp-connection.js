import { exec } from "herdr";

function codexProbe() {
  const { spawn, spawnSync } = require("child_process");
  const readline = require("readline");
  const target = process.argv[1];
  let child, done = false, bytes = 0, requestId = 1, pages = 0;
  const seen = new Set();
  const finish = result => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (child?.pid) {
      if (process.platform === "win32") {
        const stopped = spawnSync("taskkill", ["/pid", String(child.pid), "/t"], { timeout: 2000, stdio: "ignore" });
        if (stopped.status !== 0) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { timeout: 2000, stdio: "ignore" });
      }
      else { try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} } }
    }
    process.stdout.write(JSON.stringify(result), () => process.exit(0));
  };
  const timer = setTimeout(() => finish({ error: "Timed out" }), 18000);
  const send = (id, method, params) => { try { child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); } catch { finish({ error: "Codex app-server unavailable" }); } };
  const safeText = (value, max) => {
    if (typeof value !== "string") return "";
    // Withhold descriptions containing likely secrets, URLs, environment references, or paths.
    if (/(?:https?:\/\/|\bwww\.|\b(?:token|secret|password|api[_ -]?key|authorization|bearer|credential)\b|\$\{|\$[A-Z_][A-Z0-9_]*|%[A-Z_][A-Z0-9_]*%|[A-Za-z]:\\|(?:^|\s)\/(?:[^\s/]+\/)+)/i.test(value)) return "[Description withheld]";
    return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  };
  try {
    child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"], detached: process.platform !== "win32", windowsHide: true });
    child.on("error", () => finish({ error: "Codex app-server unavailable" }));
    child.on("exit", () => finish({ error: "Codex app-server exited" }));
    child.stdin.on("error", () => finish({ error: "Codex app-server unavailable" }));
    const lines = readline.createInterface({ input: child.stdout });
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) finish({ error: "Response too large" }); });
    lines.on("line", line => {
      let msg; try { msg = JSON.parse(line); } catch { return finish({ error: "Invalid response" }); }
      if (msg.id !== requestId) return;
      if (msg.error) return finish({ error: requestId === 1 ? "Initialization failed" : "Discovery unsupported or failed" });
      if (requestId === 1) {
        try { child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n"); } catch { return finish({ error: "Codex app-server unavailable" }); }
        requestId++; send(requestId, "mcpServerStatus/list", { serverName: target, detail: "toolsAndAuthOnly", limit: 100 });
        return;
      }
      const result = msg.result;
      if (!result || !Array.isArray(result.data)) return finish({ error: "Invalid response" });
      const match = result.data.find(item => item && item.name === target);
      if (match) {
        const allowedStatus = ["notStarted", "starting", "connected", "authenticationRequired", "failed", "cancelled", "disabled"];
        const allowedAuth = ["unknown", "unsupported", "notLoggedIn", "bearerToken", "oAuth"];
        if (!match.tools || typeof match.tools !== "object" || Array.isArray(match.tools)) return finish({ error: "Invalid tool inventory" });
        const tools = Object.values(match.tools).slice(0, 500).map(tool => ({ name: safeText(tool?.name, 100), description: safeText(tool?.description, 500) })).filter(tool => tool.name && tool.name !== "[Description withheld]");
        const runtimeStatus = allowedStatus.includes(match.runtimeStatus) ? match.runtimeStatus : null;
        const initialized = (match.serverInfo && typeof match.serverInfo === "object" && !Array.isArray(match.serverInfo))
          || (match.serverCapabilities && typeof match.serverCapabilities === "object" && !Array.isArray(match.serverCapabilities));
        const discoveryFailed = match.toolsError != null;
        const status = match.authStatus === "notLoggedIn" ? "authenticationRequired" : discoveryFailed ? "failed" : runtimeStatus ?? (initialized ? "connected" : null);
        return finish({ status, runtimeStatus, evidence: initialized ? "initialize" : null, auth: allowedAuth.includes(match.authStatus) ? match.authStatus : "unknown", discoveryFailed, tools, truncated: Object.keys(match.tools).length > 500 });
      }
      const cursor = result.nextCursor;
      if (cursor == null) return finish({ error: "Server not found" });
      if (typeof cursor !== "string" || seen.has(cursor) || ++pages >= 20) return finish({ error: "Invalid pagination" });
      seen.add(cursor); requestId++; send(requestId, "mcpServerStatus/list", { serverName: target, detail: "toolsAndAuthOnly", limit: 100, cursor });
    });
    send(requestId, "initialize", { clientInfo: { name: "herdr-mcp-details", version: "1.0" }, capabilities: null });
  } catch { finish({ error: "Codex app-server unavailable" }); }
}

const TTL = 60000, MAX_CONTEXTS = 32;
const checks = new Map();
const versions = new Map();
let queue = Promise.resolve();

function scopeKey(current) { return JSON.stringify([current.space ?? null, current.machine ?? null, current.cwd, current.agent]); }
export function setConnectionVersion(current, version) {
  const key = scopeKey(current);
  versions.delete(key); versions.set(key, version);
  while (versions.size > MAX_CONTEXTS) versions.delete(versions.keys().next().value);
}
export function connectionVersion(current) { return versions.get(scopeKey(current)); }

export function connectionState(result) {
  const states = { notStarted: "Not started", starting: "Starting", connected: "Connected", authenticationRequired: "Needs authentication", failed: "Connection failed", cancelled: "Cancelled", disabled: "Disabled" };
  if (result?.error) return "Check failed";
  if (result?.auth === "notLoggedIn") return "Needs authentication";
  if (result?.discoveryFailed) return "Connection failed";
  return states[result?.status] ?? "Unknown";
}

async function runCheck(current, name) {
  if (current.agent === "codex") {
    const r = await exec("node", ["-e", `(${codexProbe.toString()})()`, name], { cwd: current.cwd, on: current.machine, timeout: 23000 });
    if (r.code !== 0) throw new Error();
    return JSON.parse(r.stdout);
  }
  if (current.agent === "claude-code") {
    const r = await exec("claude", ["mcp", "get", name], { cwd: current.cwd, on: current.machine, timeout: 30000 });
    const line = r.stdout.split(/\r?\n/).find(x => /^\s*Status:/i.test(x)) ?? "";
    const status = /pending approval/i.test(line) ? "pendingApproval" : /disabled/i.test(line) ? "disabled"
      : /not authenticated|needs authentication/i.test(line) ? "authenticationRequired"
      : /failed|disconnected|not connected/i.test(line) ? "failed" : /connected/i.test(line) ? "connected"
      : /rejected|blocked/i.test(line) ? "blocked" : null;
    if (r.code !== 0 && !status) throw new Error();
    if (r.code !== 0 && status === "connected") return { status: "failed", tools: null };
    return { status, tools: null, health: status === "pendingApproval" ? "Pending approval" : status === "blocked" ? "Blocked" : undefined };
  }
  return { status: null, tools: null };
}

// One bounded probe at a time. All copies of this mod share results, never native UI elements.
export function connection(current, name, version, force = false, owner = null) {
  const key = JSON.stringify([current.space ?? null, current.machine ?? null, current.cwd, current.agent, version]);
  let context = checks.get(key);
  if (!context) context = new Map();
  checks.delete(key); checks.set(key, context);
  while (checks.size > MAX_CONTEXTS) checks.delete(checks.keys().next().value);
  let entry = context.get(name);
  if (!entry) entry = { checkedAt: 0, result: null, job: null, owners: new Set() };
  for (const client of entry.owners) if (client.closed) entry.owners.delete(client);
  if (owner) entry.owners.add(owner);
  context.set(name, entry);
  if (entry.job || (!force && entry.result && Date.now() - entry.checkedAt < TTL)) return entry;
  entry.job = queue.then(async () => {
    if (checks.get(key)?.get(name) !== entry) return;
    if (entry.owners.size && ![...entry.owners].some(client => client.active(current))) return;
    try {
      const result = await runCheck(current, name);
      entry.result = { health: result.health ?? connectionState(result), status: result.status ?? null,
        tools: Array.isArray(result.tools) ? result.tools : null, truncated: !!result.truncated,
        discoveryFailed: !!result.discoveryFailed, error: !!result.error };
    } catch { entry.result = { health: "Check failed", error: true, tools: null }; }
    finally { entry.checkedAt = Date.now(); }
  }).finally(() => { entry.job = null; });
  queue = entry.job.catch(() => {});
  return entry;
}

