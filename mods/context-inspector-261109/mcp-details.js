import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, closeOverlay, focused, readTextFile } from "herdr";
import { connection, connectionVersion } from "./mcp-connection.js";

export default class McpDetails {
  init(p, cx) {
    this.current = { space: p?.space ?? focused()?.space ?? null, cwd: p?.cwd ?? null, machine: p?.machine ?? null, agent: p?.agent ?? null };
    this.name = typeof p?.server === "string" ? p.server : "Unknown server";
    this.terminal = p?.terminal ?? null; this.overlay = p?.overlay;
    this.version = p?.version ?? "standalone"; this.closed = false;
    this.scope = null; this.transport = null;
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }
  refresh(cx, force = false) {
    if (!this.active() || !this.current.cwd) return;
    this.version = connectionVersion(this.current) ?? this.version;
    if (this.current.agent !== "codex" && this.metadataVersion !== this.version) {
      const version = this.version; this.metadataVersion = version;
      cx.spawn(async cx => {
        let scope = null, transport = null;
        try {
          const raw = await readTextFile(`${this.current.cwd}/.mcp.json`, { on: this.current.machine });
          const server = raw === null ? null : JSON.parse(raw)?.mcpServers?.[this.name];
          if (server && typeof server === "object") {
            scope = "Project .mcp.json";
            transport = ["stdio", "http", "sse", "ws"].includes(server.type) ? server.type : server.command ? "stdio" : null;
          }
        } catch { /* Metadata is optional and does not block the connection check. */ }
        if (!this.closed && this.metadataVersion === version) { this.scope = scope; this.transport = transport; cx.notify(); }
      });
    }
    const check = connection(this.current, this.name, this.version, force, this);
    const changed = this.check && this.check !== check;
    this.check = check;
    if (changed) cx.notify();
    if (!this.check.job || this.job === this.check.job) return;
    this.job = this.check.job;
    cx.spawn(async cx => { await this.job; if (!this.closed) cx.notify(); });
  }
  close() { this.closed = true; }
  active() {
    const f = focused();
    return !this.closed && (!f?.terminal || !this.terminal || f.terminal === this.terminal)
      && (!f?.space || !this.current.space || f.space === this.current.space)
      && (!f?.cwd || f.cwd === this.current.cwd);
  }
  render() {
    const t = theme(), selected = focused()?.terminal;
    const close = () => closeOverlay(this.overlay);
    if ((selected && this.terminal && selected !== this.terminal) || (focused()?.cwd && this.current?.cwd && focused().cwd !== this.current.cwd)) return v_flex().size_full().bg(t.popover).p(16).gap(12)
      .child(div().font_semibold().text_color(t.foreground).child("Terminal changed"))
      .child(div().text_color(t.muted).child("Close and select the MCP server for the current terminal."))
      .child(div().id("close-stale").cursor_pointer().text_color(t.muted).on_click(close).child("Close"));
    const result = this.check?.result, tools = result?.tools ?? [];
    const row = (label, value) => v_flex().gap(3).child(div().text_size(11).text_color(t.dim).child(label)).child(div().text_color(t.foreground).child(value));
    return v_flex().size_full().min_h(0).bg(t.popover).p(16).gap(12).text_size(13)
      .child(h_flex().items_center().gap(12)
        .child(div().flex_1().min_w(0).truncate().font_semibold().text_color(t.foreground).child(this.name))
        .child(div().id("retry").cursor_pointer().text_color(t.accent).on_click((_e,cx) => { this.refresh(cx, true); cx.notify(); }).child("Refresh"))
        .child(div().id("close").cursor_pointer().text_color(t.muted).on_click(close).child("Close")))
      .child(row("SOURCE TERMINAL", this.terminal ?? "Unknown terminal"))
      .child(row("CONFIGURATION", this.scope ?? "Agent configuration (scope not verified)"))
      .when(!!this.transport, el => el.child(row("TRANSPORT", this.transport)))
      .child(row("CONNECTION CHECK", this.check?.job ? "Checking…" : result?.health ?? "Unavailable"))
      .when(!!this.check?.checkedAt, el => el.child(div().text_size(11).text_color(t.dim).child(`Checked ${new Date(this.check.checkedAt).toLocaleTimeString()}`)))
      .child(div().text_size(11).text_color(t.dim).child("Separate CLI connection check. Active session connection status is unavailable."))
      .child(div().pt(4).text_size(11).text_color(t.dim).child("TOOLS (SEPARATE CHECK)"))
      .when(!this.check?.job && !tools.length, el => el.child(div().text_color(t.muted).child(result?.tools ? "No tools returned." : "Tool discovery unavailable.")))
      .when(!!result?.truncated, el => el.child(div().text_color(t.muted).child("Showing first 500 tools.")))
      .child(v_flex().flex_1().min_h(0).gap(10).overflow_y_scrollbar().children(tools.map(tool => v_flex().gap(3)
        .child(div().font_semibold().text_color(t.foreground).child(tool.name))
        .when(!!tool.description, el => el.child(div().text_color(t.muted).child(tool.description))))));
  }
}
