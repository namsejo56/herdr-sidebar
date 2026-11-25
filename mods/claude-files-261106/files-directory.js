import { exec, window } from "herdr";
import { joinPath } from "./files-paths.js";

const NODE_LIST = `const fs = require('fs'), path = require('path');
function listing(folder) {
  const out = [], handle = fs.opendirSync(folder);
  try { let entry; while (out.length <= 500 && (entry = handle.readSync())) {
    if (entry.name.toLowerCase() === '.git') continue;
    let dir = entry.isDirectory();
    if (entry.isSymbolicLink()) { try { dir = fs.statSync(path.join(folder, entry.name)).isDirectory(); } catch { dir = false; } }
    out.push({ name: entry.name, dir });
  } } finally { handle.closeSync(); }
  return { items: out, real: fs.realpathSync(folder) };
}`;
const NODE_DIRECTORY = NODE_LIST + '\nprocess.stdout.write(JSON.stringify(listing(process.argv[1]).items));';
const NODE_BATCH = NODE_LIST + `\nprocess.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).map(folder => { try { return { path: folder.path, ...listing(folder.full) }; } catch(error) { return { path: folder.path, error: String(error) }; } })));`;

export async function directory(path, on, context = {}) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") {
    if (!context.noNode) {
      try {
        const result = await exec("node", ["-e", NODE_DIRECTORY, path], { on });
        if (result.code === 0) return JSON.parse(result.stdout);
        // An incompatible Node also falls back; a folder error stays an error
        // if PowerShell cannot read it either.
        if (/opendirSync is not a function|cannot find module ['"](?:node:)?fs/i.test(result.stderr)) context.noNode = true;
      } catch (error) {
        if (!/cannot start node:/i.test(String(error))) throw error;
        context.noNode = true;
      }
    }
    return windowsDirectory();
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}


export async function directoryBatch(paths, context) {
  if (!context.on && window()?.platform === 'windows' && !context.noNode) {
    try {
      const result = await exec('node', ['-e', NODE_BATCH, JSON.stringify(paths.map(path => ({ path, full: joinPath(context.cwd, path) })))], { on: context.on });
      if (result.code === 0) return JSON.parse(result.stdout);
      // Folder errors are returned inside a successful batch. A failed process
      // means this runtime is unavailable; avoid retrying it for every folder.
      context.noNode = true;
    } catch (error) { if (!/cannot start node:/i.test(String(error))) throw error; context.noNode = true; }
  }
  const results = [];
  for (const path of paths) { try { results.push({ path, items: await directory(joinPath(context.cwd, path), context.on, context) }); } catch(error) { results.push({ path, error: String(error) }); } }
  return results;
}
