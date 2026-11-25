# Herdr Sidebar

A native Herdr layout with spaces and agents on the left, Files and Changes
panels, and a Context & MCP sidebar with Codex session information and controls.

![Herdr Sidebar preview; private content is covered](preview.png)

The preview is an actual Herdr screenshot with private terminal content,
project names, paths and session details covered.

## Contents

```text
layouts/native-agent-view.json
install.py
mods/
  native-agents/
  claude-transcript/
  claude-editor-pane/
  claude-files-261106/
  changes-tree-261110/
  context-tabs-261109/
  context-inspector-261109/
  mcp-details-261109/
  claude-navigation-261106/
claude-mods/
  herdr-bridge/
.claude-plugin/
  marketplace.json
tests/
RECIPE.md
preview.png
```

The layout uses the native agent sidebar. `claude-navigation-261106` is an
optional alternative navigation mod; `mcp-details-261109` keeps older overlay
calls working. The other mods implement the layout's panels and pane headers.
`claude-transcript` is an optional overlay for reading a Claude subagent transcript.
It uses the Python reader bundled in `native-agents` and needs a project,
session ID and subagent ID supplied by its caller. The default layout does not
open it.
Mod folder names are retained because code and asset paths refer to them.
`claude-mods/herdr-bridge` is a Claude Code mod, not a Herdr mod: it runs inside
Claude and feeds the Context sidebar for Claude terminals.

## Install

The installer requires Python 3.12+. Clone the repository and run the
installer from the checkout root. It copies `layouts/native-agent-view.json`
and the runtime files in `mods/`. Select the layout in Herdr after validating
the copied files.

```sh
git clone https://github.com/namsejo56/herdr-sidebar.git
cd herdr-sidebar
```

The destination is `HERDR_APP_HOME` when set, otherwise
`~/.config/herdr-app` (Windows: `%USERPROFILE%\.config\herdr-app`). Use
`--app-home PATH` to select another destination:

```powershell
# Windows
python install.py --dry-run
python install.py
python install.py --app-home C:\path\to\herdr-app
```

```sh
# Unix
python3 install.py --dry-run
python3 install.py
python3 install.py --app-home /path/to/herdr-app
```

The installer checks every destination before copying. Identical files are
skipped. A differing file, link, junction, or incompatible parent stops the
installation before any copy. `--dry-run` reports missing files without
copying. It does not rename collisions, so resolve a conflict or choose a
separate `--app-home` before retrying.

After installation, check every copied mod, then select the layout and inspect
the live app:

```sh
herdr-app check <app-home>/mods/<mod-name>
herdr-app do layout.switch --name native-agent-view
herdr-app status
```

`herdr-app check` may emit generated editor metadata such as `gpui-kit.d.ts`,
`herdr.d.ts` and `jsconfig.json` in checked mod folders. These are validation
artifacts, not package inputs; remove only those generated files if you need a
clean app-home diff. A check does not replace exercising the actual panels.

For optional Claude Code session details, run these commands from the checkout
root (the folder containing `.claude-plugin/marketplace.json`) on each machine
that runs Claude:

```sh
claude plugin marketplace add ./
claude plugin install herdr-bridge@herdr-sidebar
```

Keep only one enabled `herdr-bridge` installation. If it is already enabled
from another marketplace, disable or remove that copy first so duplicate hooks
do not publish competing snapshots or process the same request twice.
Use `/reload-plugins` when supported, or restart Claude. Inside a Herdr terminal,
the bridge writes a snapshot to `~/.claude/herdr-bridge/<terminal>.json`.

Keep `README.md`, `RECIPE.md`, `preview.png`, `tests/`, `install.py`,
`.claude-plugin/` and `claude-mods/` in the repository; they are not copied
into the app home. No personal `settings.json`, `keys.json`, agent
configuration or app state is included or required to overwrite. Switch back
to your previous layout to undo installation, then remove only the files you
added. Do not remove files while that layout or its mod panes are in use.

## Requirements and behavior

Originally exported from Herdr App 0.1.15 on Windows. The packaged layout and
mod files were compared byte-for-byte with the corresponding installed files
on Herdr App 0.1.18. The code uses Herdr's native
`herdr`/`gpui-kit`/`gpui-base` modules.
Built-in mods and icons such as `spaces`, `workspace-chrome`, `workspace-status`,
`pane`, `files`, `changes`, `agents`, `new-menu` and `peek` come from Herdr.

- Git enables Changes and file status. Node supports MCP discovery and the
  optional fast file reader. Windows file listing falls back to PowerShell;
  Unix paths use shell utilities. Python 3 supports session and subagent readers.
- Claude and Codex features require the corresponding CLI on the target machine.
  Claude process discovery in `native-agents` uses PowerShell and has Windows
  assumptions; other operating systems have not been verified for that feature.
- Files provides a tree, search, Git markers, Raw/Content views, and local
  auto-save. External changes pause saving and retain the draft. Markdown Content
  uses native text rendering; this export does not include Mermaid rendering.
- Codex MCP status comes from separate checks that may start configured servers.
  It does not establish the active terminal session's MCP connection status.
  Claude tool inventory is unavailable. Claude session details, Model/Effort
  changes and account quota need the included `herdr-bridge` Claude Code mod;
  without it the sidebar shows an install hint. Changes run `/model` or `/effort`
  once Claude is idle, and Claude also saves them as the default for new sessions.
  Claude's permission mode can show Unavailable when another plugin hides classic
  hook events from mods.
- Codex quota uses a separate app-server and may reflect a different account from
  the terminal. Model/effort, mode and permission catalogs load without a session
  ID and are shared by machine/project configuration. Applying changes requires
  an identified, already loaded session in a compatible
  Codex daemon. They may be unavailable with `--no-daemon`; the protocol is
  experimental. Remote and provider-specific behavior needs validation on your setup.
- Session Context, Account Usage and MCP Servers can be collapsed independently.
  Quota labels show time until reset, such as `5h (10m)` and `7d (2d 3h)`;
  missing reset timestamps leave the plain label, and expired timestamps show `0m`.
  The session ID has a copy button. Context usage prefers the terminal gauge and
  can fall back to the validated Codex session log when that gauge is unavailable.
- Opening an existing subagent terminal uses peek. Creating a fork requires an
  explicit confirmation in the UI.

## Development checks

Run from this repository root with Node 24+ and Python 3.12+:

```sh
node --test --test-concurrency=1 tests/*.test.cjs
python tests/session-context.test.py
python tests/session-controls.test.py
claude plugin validate .
claude plugin validate claude-mods/herdr-bridge
claude plugin test claude-mods/herdr-bridge
```

These test source behavior with isolated fixtures. They do not prove live UI,
remote-machine behavior or provider compatibility. Also run Herdr's mod checks
and exercise the actual panels. The optional Windows integration check
`python tests/codex-mcp-details-integration.py` requires Node and Codex on PATH
and starts isolated local MCP test servers.

## Share

Publish this directory as the root of a public GitHub repository, then add the
repository topic **`herdr-layout`**. It includes a whole layout and its mods.
Herdr's installed guide says Gallery discovery takes up to an hour. See the
[official sharing guide](https://github.com/herdrdev/herdr-app/blob/master/defaults/AGENTS.md#layouts-and-mods-other-people-made).

## License

Herdr Sidebar is distributed under the [Apache License 2.0](LICENSE).
Attribution for the adapted Herdr App components is in [NOTICE](NOTICE).
