# Herdr Sidebar recipe

Build a native Herdr window for working with multiple agent terminals, with
navigation on the left and focused-terminal context on the right. The files
in this repository are one implementation of this recipe.

## Window composition

Use [layouts/native-agent-view.json](layouts/native-agent-view.json) as the
layout entry point. Use theme colors throughout and keep terminal rendering
native. The left sidebar contains the built-in workspace chrome, spaces,
custom native agents list and footer. The top bar contains tabs plus Files,
Changes and Context toggles. Keep the status bar below the work area.

The center holds active tab panes. Mount `claude-editor-pane` only through
`content.pane.header`: mounting it as a root block reserves empty space because
it needs pane props. Files and Changes share a hidden stack next to the work
area. A zero-width, visible Files service block preloads metadata using
`catalogService: true`; individual views construct their own rows. Put
`context-inspector-261109` in the right-hand block.

## Modules and interactions

- `native-agents`: group or prioritize agents, show subagents, focus existing
  terminals and open existing child terminals with peek. Read Claude activity
  and Codex session records using the included Python helpers. Ask before
  creating an interactive fork when no matching live terminal exists.
- `context-tabs-261109`: preserve native tab navigation and window buttons;
  toggle Files, Changes and the Context block in this layout.
- `claude-files-261106`: browse and search by space, machine and root; cache
  metadata, refresh stale entries in the background, and watch folder changes.
  Open files in a pane with Raw/Content views. Auto-save local edits, detect
  external changes, pause conflicting saves and preserve drafts.
- `claude-editor-pane`: provide normal pane controls and file-view mode toggles;
  return to the originating tab when closing its single file pane.
- `changes-tree-261110`: inspect Git changes as a flat list or collapsible tree
  and open diffs. Keep the existing Git action confirmations and behavior.
- `context-inspector-261109`: show focused-terminal identity, MCP inventory,
  separate connection checks, tool details and Codex quota. Cache per context
  without confusing it with another terminal's identity. Read Codex session
  metadata and offer model, effort, mode and permission catalogs even before a
  session is identified. Share catalogs by machine/project configuration, keep
  selected settings scoped to the exact session, and explain unavailable writes.
  Allow each context section to collapse and the
  session ID to be copied. Prefer the terminal's context gauge, with a validated
  log fallback. Verify session identity/settings before changes.
- `mcp-details-261109`: forward older MCP overlay calls to the context inspector.
- `claude-transcript`: optional overlay displaying local Claude subagent
  transcript text. Accept project, session ID and agent ID as props, read using
  `native-agents/claude-activity.py`, and strip terminal control sequences.
  The default layout does not open it.
- `claude-navigation-261106`: retain as an optional alternative to the native
  left sidebar. It is not mounted by the default layout.

## Prerequisites and runtime access

The implementation targets the installed Herdr App 0.1.15 API. Read that
installation's generated `AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts`; use
shipped mods and assets for standard chrome, menus and terminal peek. Do not
copy editor-generated types or personal configuration into this package.

The mods execute Git, Node, Python, PowerShell or shell utilities, `hc`, Claude
and Codex as needed. They read project files, Git status, MCP/Codex configuration,
session indexes, session metadata and activity records. They watch project
folders. Files can write local project files and keep drafts in Herdr mod state;
Changes can run its existing user-invoked Git actions. Agent actions can launch
or fork terminals, and session controls can change a loaded Codex thread's settings.

MCP checks can start configured servers and those servers may reach the network.
Codex account checks use a separate app-server. No accounts, credentials,
terminal transcripts or MCP configurations ship with this package. Do not print
configuration secrets in the UI. The metadata filter is heuristic and is not
a guarantee that every server-provided secret will be recognized.

## Install and validate

Follow [README.md](README.md#install), preserving existing files. Rename both
folders and every affected source/layout reference on a collision. Do not
replace the user's settings or keys. Run `herdr-app check` on each mod, select
the copied layout, inspect `herdr-app status`, then test the actual interactions.
Verify empty, loading and error states and unavailable CLIs. Check the screenshot
and ensure the prior layout remains available for rollback. A mod check renders
only once and does not prove asynchronous behavior or all pane/overlay states.

Windows is the observed export environment. Claude process discovery uses
PowerShell; remote sessions, other operating systems and live provider/control
compatibility require separate verification. See README for the current limits.
