/**
 * sandbox-info — standalone V2 sidebar card for opencode's TUI.
 *
 * Shows ambient facts about the Docker Sandbox the terminal client runs in.
 * Everything displayed is read from INSIDE the sandbox: environment
 * variables, /proc, /etc — no host calls, no network, no launcher tooling.
 * The data layer lives in ./data.ts (UI-free, unit-testable).
 *
 * Self-gating: the card only claims a sidebar slot when the opencode TUI
 * process has SANDBOX_NAME in its environment (Docker Sandboxes sets
 * SANDBOX_NAME / SANDBOX_ID for agent sessions). On a host machine or in
 * any non-sandboxed session the plugin loads but does nothing — no slot,
 * no timers, no side effects. That makes it safe to install
 * unconditionally and to share.
 *
 * Click the card for a toast with the full, untruncated details.
 *
 * Repaint contract: the poller updates the `dyn` signal AND explicitly pokes
 * `cx.renderer.requestRender()` — the OpenTUI renderer only schedules a frame
 * on its own when it is in its interactive run loop, and signal-only updates
 * have been observed to leave the screen stale in embedded/hosted contexts
 * (frozen card, fresh click-toast). The poke is idempotent and cheap; it also
 * forces a frame whenever the renderer is idle but dirty.
 *
 * Silent-failure contract: nothing in here may throw into the TUI — the data
 * layer never throws, and every render is wrapped; on failure the card
 * degrades to an empty box and the slot to the stock sidebar.
 */

/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import {
  buildRows,
  detailText,
  GROUP_TITLES,
  inSandbox,
  POLL_MS,
  probeDynamic,
  probeStatic,
  sublineText,
  type Row,
  type RowGroup,
  type SandboxSnapshot,
} from "./data.ts"

const id = "sandbox-info"
const version = "1.0.11"

/** Conservative value budget: rows are PRE-FITTED to this, so they render
 * fully even in a ~32-column sidebar (9 label + 16 value + padding/borders
 * ≈ 31). When the panel is wider, the value cell flexes and values center
 * in the extra room; when narrower, the cell shrinks last (labels never
 * wrap) and the pre-fitted values still fit. */
const VALUE_BUDGET = 16

// ---------------------------------------------------------------------------
// Theme helpers — copied from the proven agent-status card (RGBA objects whose
// r/g/b getters may return 0–1 floats or 0–255 ints; convert defensively).
// ---------------------------------------------------------------------------

function rgbHex(color: unknown): string {
  const chan = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v <= 1 ? v * 255 : v)))
      .toString(16)
      .padStart(2, "0")
  if (color && typeof color === "object") {
    const c = color as { r?: number; g?: number; b?: number }
    if (typeof c.r === "number" && typeof c.g === "number" && typeof c.b === "number") {
      return `#${chan(c.r)}${chan(c.g)}${chan(c.b)}`
    }
  }
  if (typeof color === "string") return color
  return "#ffffff"
}

// ---------------------------------------------------------------------------
// Card component
// ---------------------------------------------------------------------------

function InfoCard(props: { cx: Context; snap: SandboxSnapshot }) {
  const cx = props.cx
  const [dyn, setDyn] = createSignal(probeDynamic(props.snap))

  onMount(() => {
    const timer = setInterval(() => {
      try {
        setDyn(probeDynamic(props.snap))
        // Explicit frame request: do not rely on the signal change alone to
        // wake the renderer (see "Repaint contract" in the header comment).
        try {
          cx.renderer.requestRender()
        } catch {
          /* renderer not exposed — signal path only */
        }
      } catch {
        /* silent — next tick retries */
      }
    }, POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  // Value column has a fixed width; rows are fitted to it deterministically
  // (no measured-width feedback loop — that caused truncate-while-stretched).
  // The card fills the sidebar width; the value cell flexes within it.
  const rows = () => buildRows(props.snap, dyn(), VALUE_BUDGET)
  const labelCol = () => 5 + 1 + 3 // "repos" + ":" + 3-space gutter (labels are a fixed vocabulary)
  const accent = () => rgbHex(cx.theme.hue.accent[500])

  const showToast = () => {
    try {
      cx.ui.toast.show({
        title: props.snap.name,
        message: detailText(props.snap, dyn()),
        variant: "info",
      })
    } catch {
      /* toasts are best-effort */
    }
  }

  return (
    <box
      gap={1}
      flexDirection="column"
      flexShrink={0}
      // Normal flow at the end of the sidebar footer: renders immediately
      // below the stock footer content (the current-directory line), no
      // absolute pinning so nothing above floats or gets overlapped.
      // bottom padding keeps a one-row gap to the terminal edge.
      paddingBottom={1}
      overflow="visible"
      minHeight={20}
    >
      <box
        flexDirection="column"
        border={true}
        borderStyle="rounded"
        borderColor={rgbHex(cx.theme.border.base)}
        padding={1}
        paddingTop={0}
        gap={0}
        // Fill the sidebar width exactly: never clips (fixed widths did) and
        // never leaves dead space (the value cell flexes to absorb slack).
        width="100%"
        // SANDBOX rendered into the top frame line (native OpenTUI border
        // title), centered, theme text color — matches sidebar header styling.
        title="SANDBOX"
        titleColor={rgbHex(cx.theme.text.base)}
        titleAlignment="center"
        onMouseDown={showToast}
      >
        {/* Name + identity subline (mode · uptime) instead of two rows. */}
        <box flexDirection="row" gap={1}>
          <text fg={accent()}>⬢</text>
          <text fg={rgbHex(cx.theme.text.base)}>
            <b>{props.snap.name}</b>
          </text>
        </box>
        <text fg={rgbHex(cx.theme.text.muted)}>{sublineText(props.snap, dyn())}</text>
        <Show when={rows().length > 0}>
          <box flexDirection="column" marginTop={1}>
            <For each={rows()}>
              {(row, i) => (
                <Show
                  when={i() > 0 && rows()[i() - 1].group !== row.group}
                  fallback={<RowLine cx={cx} row={row} labelCol={labelCol()} />}
                >
                  <box flexDirection="column" marginTop={1}>
                    <GroupHeader cx={cx} group={row.group} />
                    <RowLine cx={cx} row={row} labelCol={labelCol()} />
                  </box>
                </Show>
              )}
            </For>
          </box>
        </Show>
      </box>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Row rendering — the label/value split is unmistakable:
//   · label:  fixed column, muted color, ends with ":" (a structural cue)
//   · value:  normal text color (bright), padded value column
//   · suffix: muted metadata after the value ("+3")
// Groups get a tiny raised-background section header instead of divider bars.
// ---------------------------------------------------------------------------

function GroupHeader(props: { cx: Context; group: RowGroup }) {
  const { cx } = props
  return (
    <box backgroundColor={rgbHex(cx.theme.background.raised.base)} paddingRight={1}>
      <text fg={rgbHex(cx.theme.text.muted)}>
        {GROUP_TITLES[props.group]}
      </text>
    </box>
  )
}

function RowLine(props: { cx: Context; row: Row; labelCol: number }) {
  const { cx, row } = props
  // Label cell: "label:" padded to the shared column, left-aligned, and
  // non-shrinkable — labels can never wrap mid-word again.
  const label = `${row.label}:`.padEnd(props.labelCol + 1)
  return (
    <box flexDirection="row" title={row.full ?? row.value}>
      <text flexShrink={0} fg={rgbHex(cx.theme.text.muted)}>
        {label}
      </text>
      {/* Value cell flexes to absorb the panel's remaining width; the value
          itself was pre-fitted to VALUE_BUDGET (fits narrow panels) and
          centers in whatever room the panel offers. */}
      <box flexGrow={1} justifyContent="center">
        <text fg={rgbHex(row.warn ? cx.theme.text.feedback.warning.base : cx.theme.text.base)}>{row.value}</text>
      </box>
      <Show when={row.suffix}>
        <text flexShrink={0} fg={rgbHex(cx.theme.text.muted)}>
          {" " + row.suffix}
        </text>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------
// Plugin entrypoint. Outside a sandbox: setup returns before anything happens
// (no slot claim, no timers) and the stock sidebar renders untouched. Inside
// a sandbox the card is a bordered box prepended to the sidebar content. If
// the probe fails, the slot claim is never made and the sidebar falls back.
// ---------------------------------------------------------------------------

export default Plugin.define({
  id,
  setup(cx) {
    // CLI/TUI-only guard: if the server-side plugin loader probes this same
    // file shape, the TUI context is absent — bail out instead of crashing.
    if (!cx || !("ui" in cx) || !("data" in cx)) return

    // Sandbox gate: host machines and other non-sandboxed sessions have no
    // SANDBOX_NAME — stay fully inert there.
    if (!inSandbox()) return

    const snap = probeStatic()
    if (!snap) return

    try {
      return cx.ui.slot({
        // `append: "sidebar.footer"`: render at the bottom of the sidebar.
        // The footer slot sits after the stock content (header, session
        // title, context usage, current directory) — the card renders
        // directly below the directory text, in normal flow (no absolute
        // pinning, so nothing above floats or gets overlapped). Top
        // placements (`before`/`prepend`/`append` on "sidebar.content")
        // would put the card between the header and the context block.
        append: "sidebar.footer",
        render: () => {
          try {
            return <InfoCard cx={cx} snap={snap} />
          } catch {
            // Silent-failure contract: never break the sidebar over a card bug.
            return <box />
          }
        },
      })
    } catch {
      /* slot claim failed — card degrades to missing */
    }
  },
})
