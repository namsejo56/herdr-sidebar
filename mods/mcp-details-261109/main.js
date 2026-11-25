import { View, div } from "gpui-kit";
import { props, openOverlay, closeOverlay } from "herdr";

// Keep existing callers routed to the shared Context connection cache.
export default class McpDetails extends View {
  init() {
    const { overlay, ...detail } = props() ?? {};
    openOverlay({ mod: "context-inspector-261109", kind: "dialog", width: 500, height: 580, props: detail });
    if (overlay) closeOverlay(overlay);
  }
  render() { return div(); }
}
