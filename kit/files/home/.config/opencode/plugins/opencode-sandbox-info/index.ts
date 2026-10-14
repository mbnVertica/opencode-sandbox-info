/**
 * opencode-sandbox-info — server-side entry.
 *
 * The card lives in ./tui.tsx (loaded by the terminal client through the
 * package `./tui` export). The server discovers this plugin and loads the
 * main entry; it must be a valid V2 definition, so it is a no-op stub that
 * never parses the JSX.
 *
 * Distribution note: this package is intentionally standalone — it has no
 * dependency on any launcher tooling. Install it (or clone it) into
 * ~/.config/opencode/plugins/opencode-sandbox-info/ and it self-gates:
 * inside a Docker Sandbox (SANDBOX_NAME env) the TUI shows a sidebar card,
 * everywhere else it does nothing.
 */

import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "sandbox-info",
  setup() {},
})
