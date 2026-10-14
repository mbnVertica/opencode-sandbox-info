/**
 * Self-check: run the sandbox-info data layer against the real environment
 * and print exactly what the TUI card would show.
 *
 *   bun run selfcheck.ts          (inside a sandbox)
 *
 * Expected: rows matching the sidebar card; outside a sandbox the gate
 * reports false and the script exits without probing.
 */
import { buildRows, detailText, inSandbox, probeDynamic, probeStatic } from "./data.ts"

const gate = inSandbox()
console.log(`sandbox gate (SANDBOX_NAME set): ${gate}`)
if (!gate) {
  console.log("Not in a sandbox — the TUI plugin would stay fully inert. Nothing to show.")
  process.exit(0)
}

const snap = probeStatic()
if (!snap) {
  console.log("probeStatic() returned null — card would not render (fails closed).")
  process.exit(1)
}

const dyn = probeDynamic()
const rows = buildRows(snap, dyn)

console.log(`\n  ⬢ ${snap.name}`)
for (const r of rows) {
  console.log(`  ${(r.label + ":").padEnd(9)}${r.value}${r.warn ? "   [warn]" : ""}`)
}
console.log(`\n--- click toast ---\n${detailText(snap, dyn)}\n`)
