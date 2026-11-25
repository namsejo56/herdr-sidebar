import { spaces, panes, focused, window } from "herdr";

export function location(previous) {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const editorInSameSpace = pane?.mod === "claude-files-261106" && previous && JSON.parse(previous.key).space === space?.id && previous.on === on;
  return { cwd: pane?.cwd || f?.cwd || (editorInSameSpace ? previous.cwd : null) || space?.folder, on, space: space?.id };
}

export const normalized = (path, windows) => { const value = path.replace(/\\/g, "/"); return windows ? value.toLowerCase() : value; };
export const rootPath = path => path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
export const joinPath = (root, path) => `${rootPath(root)}${rootPath(root) === "/" ? "" : "/"}${path}`;

export function catalogKey(context) {
  const space = context.space ?? (context.key ? JSON.parse(context.key).space : null);
  return JSON.stringify([space ?? null, context.on ?? null, normalized(rootPath(context.cwd), !context.on && window()?.platform === "windows")]);
}

export function affectsFolder(folder, paths, context) {
  const root = normalized(rootPath(context.cwd), context.windows);
  const changed = paths?.map(path => normalized(rootPath(path), context.windows));
  if (!changed?.length || changed.includes(root)) return true;
  const full = normalized(rootPath(joinPath(context.cwd, folder)), context.windows);
  return changed.some(path => path === full || full.startsWith(path + "/") || rootPath(path.slice(0, path.lastIndexOf("/"))) === full);
}
