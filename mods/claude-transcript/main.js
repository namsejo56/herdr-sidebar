import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, exec, props, theme } from "herdr";

// Display transcript text literally, without allowing terminal control sequences.
function plainText(value) {
  return String(value ?? "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

export default class ClaudeTranscript extends View {
  init(_props, cx) {
    const { project, session_id, agent_id } = props() ?? {};
    this.loading = true;
    this.text = "";
    this.partial = false;
    this.error = null;
    cx.spawn(async (cx) => {
      try {
        const result = await exec("python", [
          appHome() + "/mods/native-agents/claude-activity.py",
          "read",
          JSON.stringify({ project, session_id, agent_id }),
        ]);
        if (result.code !== 0) throw new Error("Could not read the transcript.");
        const data = JSON.parse(result.stdout);
        this.text = plainText(data.text);
        this.partial = Boolean(data.partial);
        this.error = data.error ? plainText(data.error) : null;
      } catch (_) {
        this.error = "Could not read the transcript.";
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  render(_cx) {
    const t = theme();
    const name = plainText(props()?.name || "Subagent");
    return v_flex().size_full().min_h(0).bg(t.chrome).text_color(t.foreground)
      .child(h_flex().px(16).h(44).flex_none().gap(12).items_center()
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(`${name} transcript`))
        .child(div().id("close-transcript").px(8).py(4).rounded(4).cursor_pointer()
          .hover(el => el.bg(t.hover)).on_click(() => closeOverlay(props().overlay)).child("Close")))
      .when(this.loading, el => el.child(div().px(16).py(8).text_color(t.muted).child("Loading transcript…")))
      .when(Boolean(this.error), el => el.child(div().px(16).py(8).text_color(t.blocked).child(`Error: ${this.error}`)))
      .when(this.partial, el => el.child(div().px(16).py(8).text_color(t.muted).child("Partial transcript: some content was omitted.")))
      .when(!this.loading && !this.error && !this.text, el => el.child(div().px(16).py(8).text_color(t.muted).child("No transcript text available.")))
      .child(v_flex().id("transcript-text").flex_1().min_h(0).px(16).pb(16).overflow_y_scrollbar().mode("always")
        .child(div().text_size(13).text_color(t.foreground).child(this.text)));
  }
}
