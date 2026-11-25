import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, focused, terminals } from "herdr";
import { controlSession, readSession, permissionLabel, cachedSessionOptions } from "./session-context.js";

export default class SessionControls {
  init(p, cx, onClose) {
    this.current = { ...p }; this.field = p.control; this.onClose = onClose;
    this.closed = false; this.loading = true; this.busy = false;
    this.state = p.state ?? {};
    const cached = cachedSessionOptions(this.current, p.session, this.field);
    if (cached) { this.state = cached.state ?? this.state; this.choices = cached.choices; this.loading = false; return; }
    cx.spawn(async cx => {
      try {
        const response = await controlSession(this.current, p.session, "options", this.field);
        if (this.closed) return;
        this.state = response.state ?? this.state; this.choices = response.choices ?? [];
      } catch (error) { if (!this.closed) this.error = error.message; }
      finally { if (!this.closed) { this.loading = false; cx.notify(); } }
    });
  }
  close() { this.closed = true; }
  active() {
    const f = focused();
    return !this.closed && f?.terminal === this.current.terminal && f?.space === this.current.space && f?.cwd === this.current.cwd;
  }
  save(value, cx, field = this.field) {
    if (this.busy || !this.state || !this.active()) return;
    if (!this.current.session) { this.error = "Session not identified yet. Start the session, then reopen this picker to apply changes."; cx.notify(); return; }
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async cx => {
      try {
        const all = terminals(), terminal = all.find(t => t.address === this.current.terminal);
        if (!terminal || !this.active()) throw new Error("Terminal changed. Close and reopen the picker.");
        const name = terminal.title?.split(" | ", 1)[0].trim();
        const snapshot = await readSession({ ...this.current, sessionTitle: terminal.title,
          duplicateTitle: !!name && all.filter(t => t.title?.split(" | ", 1)[0].trim() === name).length > 1 });
        if (!this.active() || snapshot.session !== this.current.session) throw new Error("Session changed. Close and reopen the picker.");
        const expected = {};
        for (const key of ["model", "effort", "mode", "permission", "approvalPolicy", "approvalsReviewer"]) expected[key] = this.state[key] ?? null;
        await controlSession(this.current, this.current.session, "update", field, value, expected);
        if (!this.closed) { this.saved = true; this.onClose(cx); }
      } catch (error) { if (!this.closed) this.error = error.message; }
      finally { if (!this.closed) { this.busy = false; cx.notify(); } }
    });
  }
  render() {
    const t = theme(), labels = { model: "Model & effort", effort: "Reasoning effort", mode: "Session mode", permissions: "Permissions" };
    const choice = (id, label, detail, selected, action) => v_flex().id(id).p(8).gap(3).rounded(4)
      .bg(selected ? t.selected : t.popover).cursor_pointer().hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { if (!this.busy && this.active()) action(cx); })
      .child(div().text_color(t.foreground).child(label))
      .when(!!detail, el => el.child(div().text_size(11).text_color(t.muted).child(detail)));
    const items = [], claude = this.current.agent === "claude-code";
    if (claude && (this.field === "model" || this.field === "effort")) {
      for (const option of this.choices ?? []) items.push(choice(`${this.field}-${option.id}`, option.name, null,
        option.id === this.state?.[this.field], cx => this.save(option.id, cx)));
    } else if (this.field === "model" && !this.selectedModel) {
      for (const model of this.choices ?? []) items.push(choice(`model-${model.id}`, model.name,
        null, model.id === this.state?.model, cx => { this.selectedModel = model; cx.notify(); }));
    } else if (this.field === "model" || this.field === "effort") {
      const model = this.selectedModel ?? this.choices?.find(m => m.id === this.state?.model);
      if (!model && this.field === "effort") {
        for (const available of this.choices ?? []) items.push(choice(`model-${available.id}`, available.name, "Choose model to view supported efforts", false,
          cx => { this.selectedModel = available; cx.notify(); }));
      }
      for (const effort of model?.efforts ?? []) items.push(choice(`effort-${effort}`, effort,
        effort === "ultra" ? "Allows automatic task delegation" : null,
        effort === this.state?.effort && model?.id === this.state?.model,
        cx => this.save(this.field === "model" || this.selectedModel ? { model: model.id, effort } : effort, cx,
          this.field === "model" || this.selectedModel ? "model" : "effort")));
    } else if (this.field === "mode") {
      for (const mode of this.choices ?? []) items.push(choice(`mode-${mode.id}`, mode.name, null,
        mode.id === this.state?.mode, cx => this.save(mode.id, cx)));
    } else if (this.field === "permissions" && !this.selectedPermission) {
      for (const profile of this.choices ?? []) items.push(choice(`permission-${profile.id}`, permissionLabel(profile.id), profile.description,
        profile.id === this.state?.permission, cx => { this.selectedPermission = profile; cx.notify(); }));
    } else if (this.field === "permissions") {
      for (const [policy, name] of [["on-request", "Ask when needed"], ["never", "Never ask"]]) items.push(choice(`approval-${policy}`, name,
        permissionLabel(this.selectedPermission.id), policy === this.state?.approvalPolicy,
        cx => this.save({ permission: this.selectedPermission.id, approvalPolicy: policy }, cx)));
    }
    return v_flex().w(280).min_h(0).max_h(360).bg(t.popover).border_1().border_color(t.border).rounded(6).p(8).gap(6).text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(this.selectedModel?.name ?? (claude && this.field === "model" ? "Model" : labels[this.field]) ?? "Session settings"))
      .when(!this.active(), el => el.child(div().text_color(t.muted).child("Terminal changed. Close and reopen this picker.")))
      .when(this.loading, el => el.child(div().text_color(t.dim).child("Reading session settings…")))
      .when(this.busy, el => el.child(div().text_color(t.dim).child(claude ? "Waiting for Claude to be idle…" : "Applying and verifying…")))
      .when(!!this.error, el => el.child(div().text_color(t.muted).child(this.error)))
      .when(!this.loading && !this.busy && !this.error && !items.length, el => el.child(div().text_color(t.muted).child("No available choices for this session.")))
      .when(!!this.selectedModel || !!this.selectedPermission, el => el.child(div().id("controls-back").cursor_pointer().text_color(t.accent)
        .on_click((_e,cx) => { if (!this.busy) { this.selectedModel = null; this.selectedPermission = null; cx.notify(); } }).child("Back")))
      .child(v_flex().min_h(0).h(this.active() && !this.loading && !this.busy ? Math.min(270, items.length * 38) : 0)
        .gap(2).overflow_y_scrollbar().children(this.active() && !this.loading && !this.busy ? items : []))
      .child(div().text_size(11).text_color(t.dim).child(!this.current.session ? "Choices are available. Applying changes requires an identified session."
        : claude ? `Runs /${this.field} once Claude is idle; Claude also saves it as the default for new sessions.` : "Applies to the next turn."));
  }
}
