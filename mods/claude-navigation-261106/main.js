import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { spaces, agents, machines, theme, run, openOverlay, closeOverlay, props, knownAgents, pickFolder, notify, setAgentOrder } from "herdr";
const MOD = "claude-navigation-261106";
const ready = (id, machine) => {
  const s = spaces().find(s => s.id === id);
  return !!s && (s.machine ?? null) === machine && machines().some(m => (m.name ?? null) === machine && m.layout === "ready");
};
export default class Navigation extends View {
  init(p, cx) {
    this.dialog = !!p?.newTab;
    this.pinDialog = !!p?.pins;
    if (this.dialog || this.pinDialog) {
      this.handle = cx.focus_handle(); this.handle.focus();
      this.scroll = VirtualListScrollHandle.new();
      this.selection = this.pinDialog ? "close-pins" : "terminal";
    }
    if (this.pinDialog) {
      this.pinSpace = p.space; this.pinTab = p.tab;
      const first = agents().find(a => a.space === this.pinSpace && a.tab === this.pinTab);
      if (first) this.selection = `pin:${first.address}`;
      return;
    }
    if (!this.dialog) { this.width = 268; return; }
    this.spaceId = p.space; this.machine = p.machine ?? null; this.folder = null;
    this.loading = true; this.list = [];
    cx.spawn(async cx => {
      try { this.list = await knownAgents({ on: this.machine }); }
      catch { this.error = "Could not check agents on this machine."; }
      this.loading = false; cx.notify();
    });
  }
  warn() { notify({ title: "New tab cancelled", body: "The original space or machine is no longer available.", level: "warning" }); }
  create(agent) {
    if (!ready(this.spaceId, this.machine)) { this.warn(); return; }
    const args = { space: this.spaceId };
    if (this.folder) args.folder = this.folder;
    if (agent) { args.name = agent.name; args.argv = agent.run; }
    run("tab.new", args); closeOverlay(props().overlay);
  }
  chooseFolder(cx) {
    if (this.machine !== null || !ready(this.spaceId, this.machine)) { this.warn(); return; }
    cx.spawn(async cx => {
      try {
        const folder = await pickFolder({ prompt: "Choose a folder for the new tab" });
        if (!ready(this.spaceId, this.machine)) { this.warn(); closeOverlay(props().overlay); return; }
        if (folder) this.folder = folder;
      } catch { this.error = "Could not open the folder picker."; }
      cx.notify();
    });
  }
  action(id, label, fn, enabled = true) {
    const t = theme();
    return div().id(id).px(10).py(7).rounded(6).text_color(enabled ? t.foreground : t.dim)
      .when(enabled, el => el.hover(s => s.bg(t.hover)).cursor_pointer().on_click(fn)).child(label);
  }
  dialogOptions() {
    if (this.pinDialog) {
      const list = agents().filter(a => a.space === this.pinSpace && a.tab === this.pinTab);
      return [
        ...list.map(a => ({ id: `pin:${a.address}`, label: `${a.pinned ? "Unpin" : "Pin"} ${a.program?.name || a.app || "Agent"} (${a.address})` })),
        { id: "close-pins", label: "Close" },
      ];
    }
    const valid = ready(this.spaceId, this.machine);
    return [
      ...(this.machine === null ? [{ id: "folder", label: "Choose folder?", enabled: valid }] : []),
      ...(this.folder ? [{ id: "default-folder", label: "Use default folder", enabled: valid }] : []),
      { id: "terminal", label: "Terminal", enabled: valid },
      ...this.list.filter(a => a.installed).map(a => ({ id: `agent:${JSON.stringify([a.name, a.run])}`, label: `Agent: ${a.name}`, enabled: valid })),
      { id: "cancel", label: "Cancel" },
    ];
  }
  selectedDialogOption(options) {
    return options.some(o => o.id === this.selection && o.enabled !== false)
      ? this.selection : (this.pinDialog ? "close-pins" : "cancel");
  }
  activateDialog(id, cx) {
    const option = this.dialogOptions().find(o => o.id === id && o.enabled !== false);
    if (!option) return;
    this.selection = id;
    if (id === "cancel" || id === "close-pins") { closeOverlay(props().overlay); return; }
    if (id === "folder") this.chooseFolder(cx);
    else if (id === "default-folder") this.folder = null;
    else if (id === "terminal") { this.create(null); return; }
    else if (id.startsWith("agent:")) {
      const agent = this.list.find(a => a.installed && `agent:${JSON.stringify([a.name, a.run])}` === id);
      if (agent) { this.create(agent); return; }
    } else if (id.startsWith("pin:")) {
      const agent = agents().find(a => a.address === id.slice(4) && a.space === this.pinSpace && a.tab === this.pinTab);
      if (agent) run("terminal.pin", { terminal: agent.address, pinned: !agent.pinned });
    }
    cx.notify();
  }
  dialogKey(event, cx) {
    const key = event.keystroke;
    if (key === "escape") { cx.stop_propagation(); closeOverlay(props().overlay); return; }
    if (key === "enter" || key === "space") {
      cx.stop_propagation(); this.activateDialog(this.selectedDialogOption(this.dialogOptions()), cx); return;
    }
    const direction = key === "down" || key === "tab" ? 1 : key === "up" || key === "shift-tab" ? -1 : 0;
    if (!direction) return;
    cx.stop_propagation();
    const options = this.dialogOptions(), enabled = options.filter(o => o.enabled !== false);
    const current = enabled.findIndex(o => o.id === this.selectedDialogOption(options));
    const next = current < 0 ? (direction > 0 ? 0 : enabled.length - 1) : (current + direction + enabled.length) % enabled.length;
    this.selection = enabled[next].id;
    this.scroll.scroll_to_item(options.findIndex(o => o.id === this.selection));
    cx.notify();
  }
  renderDialog() {
    const t = theme(), valid = this.pinDialog || ready(this.spaceId, this.machine);
    const space = this.pinDialog ? null : spaces().find(s => s.id === this.spaceId);
    const options = this.dialogOptions(), selectedId = this.selectedDialogOption(options);
    return v_flex().id(this.pinDialog ? "pin-dialog" : "new-dialog").role("dialog")
      .accessibility_label(this.pinDialog ? "Agent pins" : "New tab")
      .track_focus(this.handle).on_key_down((event, cx) => this.dialogKey(event, cx))
      .size_full().bg(t.popover).p(8).gap(3).text_size(13)
      .child(div().px(10).py(6).font_semibold().text_color(t.foreground).child(this.pinDialog ? "Agent pins" : "New tab"))
      .when(!this.pinDialog, el => el
        .child(div().px(10).text_color(t.muted).child(space ? `${space.name} (${space.id})` : "Space unavailable"))
        .child(div().px(10).py(5).min_w(0).truncate().text_color(t.dim).child(this.machine ? `Remote: ${this.machine} ? default folder` : (this.folder || "Default space folder")))
        .when(this.loading, e => e.child(div().px(10).py(4).text_color(t.dim).child("Checking installed agents?")))
        .when(!!this.error, e => e.child(div().px(10).py(4).text_color(t.dim).child(this.error)))
        .when(!this.loading && !this.error && !this.list.some(a => a.installed), e => e.child(div().px(10).py(4).text_color(t.dim).child("No installed agents found.")))
        .when(!valid, e => e.child(div().px(10).py(4).text_color(t.dim).child("Space or machine unavailable. Close and try again."))))
      .when(this.pinDialog && options.length === 1, el => el.child(div().px(10).py(4).text_color(t.dim).child("No active agents in this tab.")))
      .child(v_virtual_list("dialog-options", options.length, 32, i => options[i].id, range =>
        options.slice(range.start, range.end).map(o => {
          const selected = o.id === selectedId;
          return div().h(32).px(10).rounded(6).truncate().role("button").accessibility_label(o.label)
            .when(selected, el => el.bg(t.selected).border_1().border_color(t.accent).aria_active_descendant())
            .text_color(o.enabled === false ? t.dim : t.foreground).child(o.label);
        }))
        .flex_1().min_h(0).track_scroll(this.scroll)
        .on_item_click((id, cx) => this.activateDialog(id, cx)));
  }
  tabRow(space, tab, tabAgents, index) {
    const t = theme(), active = space.active && tab.active;
    return h_flex().id(`tab-${index}`).min_w(0).h(32).px(8).gap(4).items_center().rounded(6)
      .bg(active ? t.selected : t.chrome).hover(s => s.bg(t.hover)).cursor_pointer()
      .child(div().id(`select-${index}`).flex_1().min_w(0).truncate().text_color(active ? t.foreground : t.muted)
        .tooltip(`${tab.name} · ${space.name} (${space.id})`)
        .on_click(() => { if (!space.active) run("space.select", { id: space.id }); run("tab.select", { id: tab.id }); }).child(tab.name))
      .when(tabAgents.length > 0, el => el.child(div().id(`pins-${index}`).flex_none().px(3).text_color(tabAgents.some(a => a.pinned) ? t.accent : t.dim)
        .tooltip(tabAgents.some(a => a.pinned) ? "Manage pinned agents" : "Manage agent pins")
        .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: MOD, kind: "popup", width: 300, height: 250, props: { pins: true, space: space.id, tab: tab.id } }); })
        .child(svg(`mods/workspace-chrome/${tabAgents.some(a => a.pinned) ? "pin-off" : "pin"}.svg`).size(13))));
  }
  render() {
    if (this.dialog) return this.renderDialog();
    if (this.pinDialog) return this.renderDialog();
    const t = theme(), allSpaces = spaces(), allAgents = agents(), active = allSpaces.find(s => s.active);
    let index = 0;
    const groupsFor = pinned => allSpaces.map(s => ({ space: s, tabs: (s.tabs || []).map(tab => ({ tab, agents: allAgents.filter(a => a.space === s.id && a.tab === tab.id) })).filter(item => item.agents.some(a => a.pinned) === pinned) })).filter(g => g.tabs.length);
    const pinnedGroups = groupsFor(true), sessionGroups = groupsFor(false);
    setAgentOrder([...pinnedGroups, ...sessionGroups].flatMap(g => g.tabs.flatMap(item => item.agents.map(a => a.address))));
    const section = (groups, pinned, label) => {
      return v_flex().gap(2).child(div().px(8).pt(12).pb(4).text_size(11).font_semibold().text_color(t.dim).child(label))
        .when(!groups.length, el => el.child(div().px(8).py(4).text_color(t.dim).child(pinned ? "No pinned agents" : "No tabs")))
        .children(groups.map(g => v_flex().gap(2)
          .child(div().px(8).pt(6).text_size(11).text_color(t.muted).truncate().tooltip(`${g.space.name} (${g.space.id})`).child(`${g.space.name} · ${g.space.id}`))
          .children(g.tabs.map(item => this.tabRow(g.space, item.tab, item.agents, index++)))));
    };
    return v_flex().id("navigation").size_full().min_w(0).bg(t.chrome).px(6).text_size(13)
      .on_size_change((size, cx) => { if (this.width !== size.width) { this.width = size.width; cx.notify(); } })
      .child(this.action("new-tab", this.width < 100 ? "+" : "+ New", () => {
        const s = spaces().find(s => s.active);
        if (!s || !ready(s.id, s.machine ?? null)) { this.warn(); return; }
        openOverlay({ mod: MOD, kind: "dialog", width: 360, height: 440, props: { newTab: true, space: s.id, machine: s.machine ?? null } });
      }, !!active))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().child(section(pinnedGroups, true, "Pinned")).child(section(sessionGroups, false, "Sessions")));
  }
}
