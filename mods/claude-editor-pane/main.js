// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, spaces, props, run, theme, home, shared, setShared } from "herdr";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init(_props, cx) { this.hovered = false; this.rawFocus = cx.focus_handle(); this.contentFocus = cx.focus_handle(); }

  close() { this.rawFocus.release(); this.contentFocus.release(); }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    if (p.mod === "claude-files-261106") {
      const tab = spaces().flatMap(s => s.tabs || []).find(tab => tab.id === p.tab);
      const modeKey = `files.editor.mode:${p.tab}`;
      const mode = shared(modeKey) || "raw";
      const choice = (id, title, glyph) => div().id(`editor-${id}-${p.pane}`)
        .size(25).flex().items_center().justify_center().rounded(5)
        .track_focus(id === "raw" ? this.rawFocus : this.contentFocus).tab_index(0).role("button")
        .accessibility_label(title).tooltip(title)
        .bg(mode === id ? t.selected : t.background)
        .text_color(mode === id ? t.foreground : t.dim)
        .focus(s => s.bg(t.hover).text_color(t.foreground))
        .cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { cx.stop_propagation(); setShared(modeKey, id); })
        .on_key_down((e, cx) => { if (e.keystroke === "enter" || e.keystroke === "space") { cx.stop_propagation(); setShared(modeKey, id); } })
        .child(glyph);
      return h_flex().size_full().px(10).gap(6).items_center().bg(t.background)
        .border_b(1).border_color(t.border).text_size(12)
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(tab?.name || "File"))
        .child(choice("raw", "Raw", div().font_semibold().child("</>")))
        .child(choice("content", "Content", svg("mods/files/file.svg").size(14)))
        .when(this.hovered, el => el.child(div().id(`ph-x-${p.pane}`).p(3).rounded(4).text_color(t.dim)
          .hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            const origin = shared(`files.editor.origin:${p.tab}`);
            const owner = spaces().find(s => s.tabs?.some(tab => tab.id === p.tab));
            if (origin && owner?.tabs.some(tab => tab.id === origin) && panes().filter(pane => pane.tab === p.tab).length === 1) run("tab.select", { id: origin });
            run("pane.close", { pane: p.pane });
          }).child(svg("mods/pane/close.svg").size(14))))
        .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); });
    }
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
