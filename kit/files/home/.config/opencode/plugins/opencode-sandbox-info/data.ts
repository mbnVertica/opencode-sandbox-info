/**
 * sandbox-info — ambient data layer.
 *
 * Pure, dependency-free probing of the sandbox environment: environment
 * variables, /proc, /etc. Every function returns null (or an empty array) on
 * any failure and never throws, so the TUI card can degrade row-by-row.
 *
 * Everything is read from INSIDE the sandbox — no host calls, no network.
 * One `df -k /` subprocess for filesystem usage; everything else is plain
 * file reads.
 *
 * Runtime-agnostic: the opencode TUI runs on Bun, selfcheck/tests may run on
 * Node — file access goes through `process.getBuiltinModule` (Node ≥22.3 /
 * Bun ≥1.1), falling back to the ambient `require` on older Bun.
 *
 * This module is intentionally UI-free so it can be unit-tested or run
 * directly (`node selfcheck.ts` / `bun run selfcheck.ts`) without a terminal.
 */

// --- fs access -------------------------------------------------------------

type FsLike = { readFileSync(path: string, enc: string): string; existsSync(path: string): boolean }

/** Cached fs module, resolved lazily and synchronously. */
let _fs: FsLike | null | undefined

function fsOrNull(): FsLike | null {
  if (_fs !== undefined) return _fs
  _fs = null
  try {
    // Node ≥22.3 and Bun ≥1.1: synchronous builtin resolution, works in ESM.
    const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
    if (typeof get === "function") {
      _fs = get.call(process, "node:fs") as FsLike
      if (_fs) return _fs
    }
  } catch {
    /* fall through */
  }
  try {
    // Older runtimes with an ambient require (Bun TUI scope).
    if (typeof require === "function") {
      _fs = require("fs") as FsLike
    }
  } catch {
    /* stays null */
  }
  return _fs
}

function readText(path: string): string | null {
  try {
    const fs = fsOrNull()
    return fs ? fs.readFileSync(path, "utf8") : null
  } catch {
    return null
  }
}

// --- environment -----------------------------------------------------------

export const POLL_MS = 60_000

/** Sandbox gate: Docker Sandboxes exports SANDBOX_NAME for agent sessions. */
export const inSandbox = (): boolean =>
  typeof process !== "undefined" && !!process.env.SANDBOX_NAME

function envGet(key: string): string | null {
  try {
    const v = process.env[key]
    const t = typeof v === "string" ? v.trim() : ""
    return t ? t : null
  } catch {
    return null
  }
}

// --- probes (all null/[] on failure, never throw) --------------------------

/** Repository-style directory names directly inside `dir`: only directories
 * (files skipped — keeps AGENTS.md and friends out), no hidden entries. */
export function repoDirs(dir: string | null): string[] {
  try {
    if (!dir) return []
    const fs = fsOrNull()
    if (!fs) return []
    const st = (fs as unknown as { statSync?: (p: string) => { isDirectory(): boolean } }).statSync
    const rd = (fs as unknown as { readdirSync?: (p: string) => string[] }).readdirSync
    if (typeof rd !== "function" || typeof st !== "function") return []
    const names = rd.call(fs, dir).filter((n: string) => !n.startsWith("."))
    const dirs: string[] = []
    for (const n of names) {
      try {
        if (st.call(fs, `${dir}/${n}`).isDirectory()) dirs.push(n)
      } catch {
        /* vanished mid-listing — skip */
      }
    }
    return dirs.sort()
  } catch {
    return []
  }
}

/** Load-average triple from /proc/loadavg. */
export function loadAvg(): { l1: number; l5: number; l15: number } | null {
  try {
    const text = readText("/proc/loadavg")
    if (!text) return null
    const parts = text.trim().split(/\s+/)
    const l1 = Number.parseFloat(parts[0])
    const l5 = Number.parseFloat(parts[1])
    const l15 = Number.parseFloat(parts[2])
    if (![l1, l5, l15].every(Number.isFinite)) return null
    return { l1, l5, l15 }
  } catch {
    return null
  }
}

/** Memory in use, in KiB, from /proc/meminfo (MemTotal − MemAvailable).
 * Sandbox-wide (the container's view of the VM's memory). */
export function memoryUsage(): { usedKiB: number; totalKiB: number } | null {
  try {
    const text = readText("/proc/meminfo")
    if (!text) return null
    const grab = (key: string): number | null => {
      const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)
      return m ? Number.parseInt(m[1], 10) : null
    }
    const total = grab("MemTotal")
    const avail = grab("MemAvailable") ?? grab("MemFree")
    if (total === null || avail === null || total <= 0) return null
    return { usedKiB: total - avail, totalKiB: total }
  } catch {
    return null
  }
}

/** Best filesystem for a path: the deepest mounted filesystem containing it,
 * in KiB. Used to read the disk of a host bind mount (which differs from the
 * container overlay). */
export function diskUsageFor(path: string | null): { usedKiB: number; totalKiB: number } | null {
  try {
    if (!path) return null
    const fs = fsOrNull()
    if (!fs || !fs.existsSync(path)) return null
    const out = spawnCapture(["df", "-k", path])
    if (!out) return null
    const lines = out.trim().split("\n")
    if (lines.length < 2) return null
    const cols = lines[lines.length - 1].trim().split(/\s+/)
    const total = Number.parseInt(cols[1], 10)
    const used = Number.parseInt(cols[2], 10)
    if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) return null
    return { usedKiB: used, totalKiB: total }
  } catch {
    return null
  }
}

/** Credential injection modes visible to the sandbox: env keys like
 * SBX_CRED_GITHUB_MODE=apikey → { GITHUB: "apikey" }. Read from our own
 * process environment first, then PID 1's (identical at attach). */
export function credentialModes(): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    let text: string | null = null
    for (const [k, v] of Object.entries(process.env ?? {})) {
      if (k.startsWith("SBX_CRED_") && k.endsWith("_MODE") && typeof v === "string" && v) {
        out[k.replace(/^SBX_CRED_/, "").replace(/_MODE$/, "")] = v
      }
    }
    if (Object.keys(out).length > 0) return out
    text = readText("/proc/1/environ")
    if (!text) return out
    for (const entry of text.split("\0")) {
      const m = /^SBX_CRED_([A-Z0-9]+)_MODE=(.+)$/.exec(entry)
      if (m && m[2]) out[m[1]] = m[2]
    }
  } catch {
    /* empty map */
  }
  return out
}

/** True when the sandbox MCP gateway is configured (MCP_GATEWAY_URL set). */
export function mcpGateway(): boolean {
  return !!envGet("MCP_GATEWAY_URL")
}

/** Host directories mounted into the sandbox: lines in /proc/mounts whose
 * device is literally "host" (sbx virtiofs mounts), e.g. "host /d/Projects/acme virtiofs ...". */
export function hostMounts(): string[] {
  try {
    const text = readText("/proc/mounts")
    if (!text) return []
    const out: string[] = []
    for (const line of text.split("\n")) {
      const parts = line.split(" ")
      if (parts.length >= 3 && parts[0] === "host" && parts[1] && parts[1] !== "/") out.push(parts[1])
    }
    return out
  } catch {
    return []
  }
}

/** Kit names from the sandbox startup manifest (present in sandboxes that
 * provision through durable startup hooks). Missing elsewhere. */
export function kitNames(): string[] {
  try {
    const text = readText("/etc/durable-startup.d/manifest.json")
    if (!text) return []
    const parsed = JSON.parse(text) as { kits?: unknown }
    if (!Array.isArray(parsed?.kits)) return []
    return parsed.kits.filter((k): k is string => typeof k === "string" && !!k.trim())
  } catch {
    return []
  }
}

/** Docker-in-docker: the sandbox's own nested docker daemon socket. */
export function dockerSocket(): boolean {
  try {
    const fs = fsOrNull()
    return !!fs && (fs.existsSync("/run/docker.sock") || fs.existsSync("/var/run/docker.sock"))
  } catch {
    return false
  }
}

/** Minimal ambient Bun typing (the TUI runtime). Declared locally so the
 * package does not need @types/bun to typecheck. */
declare const Bun: {
  spawnSync(
    args: string[],
    options?: { stdout?: string; stderr?: string },
  ): { exitCode: number | null; stdout: Uint8Array; stderr: Uint8Array }
}

/** Root filesystem usage, in KiB. Runs `df -k /`: under Bun via spawnSync,
 * under Node via child_process (selfcheck/probes). Returns null on failure. */
export function diskUsage(): { usedKiB: number; totalKiB: number } | null {
  try {
    const out = spawnCapture(["df", "-k", "/"])
    if (!out) return null
    const lines = out.trim().split("\n")
    if (lines.length < 2) return null
    const cols = lines[lines.length - 1].trim().split(/\s+/)
    // df -k /: Filesystem 1024-blocks Used Available Capacity ...
    const total = Number.parseInt(cols[1], 10)
    const used = Number.parseInt(cols[2], 10)
    if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) return null
    return { usedKiB: used, totalKiB: total }
  } catch {
    return null
  }
}

/** Synchronous `cmd` capture. Bun: spawnSync. Node: execFileSync via
 * getBuiltinModule (no imports needed at module top level). */
function spawnCapture(cmd: string[]): string | null {
  try {
    if (typeof Bun !== "undefined") {
      const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" })
      if (proc.exitCode !== 0) return null
      return proc.stdout.toString()
    }
    const cp = getBuiltin("node:child_process") as
      | { execFileSync: (file: string, args: string[], opts?: Record<string, unknown>) => Buffer }
      | null
    if (!cp) return null
    const buf = cp.execFileSync(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "ignore"] })
    return buf ? buf.toString() : null
  } catch {
    return null
  }
}

/** Synchronous builtin resolution (Node ≥22.3 / Bun ≥1.1), ambient require
 * fallback; null when unavailable. */
function getBuiltin(id: string): unknown {
  try {
    const get = (process as unknown as { getBuiltinModule?: (mid: string) => unknown }).getBuiltinModule
    if (typeof get === "function") return get.call(process, id)
  } catch {
    /* fall through */
  }
  try {
    if (typeof require === "function") return require(id.replace(/^node:/, ""))
  } catch {
    /* not available */
  }
  return null
}

/** Sandbox uptime in seconds (container uptime — /proc/uptime inside the
 * container namespace, not the host VM's). */
export function uptimeSeconds(): number | null {
  try {
    const text = readText("/proc/uptime")
    if (!text) return null
    const v = Number.parseFloat(text.split(" ")[0])
    return Number.isFinite(v) && v >= 0 ? v : null
  } catch {
    return null
  }
}

/** OS pretty name from /etc/os-release. */
export function osPretty(): string | null {
  try {
    const text = readText("/etc/os-release")
    if (!text) return null
    const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text)
    return m?.[1]?.trim() || null
  } catch {
    return null
  }
}

/** Kernel release — read directly, no subprocess needed. */
export function kernelRelease(): string | null {
  try {
    return readText("/proc/sys/kernel/osrelease")?.trim() || null
  } catch {
    return null
  }
}

// --- formatting helpers ------------------------------------------------------

export function humanKiB(kib: number): string {
  if (kib >= 1024 * 1024) return `${(kib / (1024 * 1024)).toFixed(1)}G`
  if (kib >= 1024) return `${Math.round(kib / 1024)}M`
  return `${kib}K`
}

export function humanUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3_600)
  const m = Math.floor((seconds % 3_600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${Math.max(1, Math.round(seconds))}s`
}

/** Tail-truncate for narrow card rows. */
export function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

/** Tail-truncate with the head kept but shortened (paths stay recognizable). */
export function clampMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const keep = Math.max(3, max - 2)
  return `…${text.slice(text.length - keep)}`
}

// --- snapshot + rows ---------------------------------------------------------

export type RowGroup = "identity" | "workspace" | "environment" | "resources"

export type Row = {
  key: string
  label: string
  /** Logical group; the card renders a small section header per group. */
  group: RowGroup
  value: string
  /** Optional trailing metadata (e.g. "+3"), rendered muted after the value. */
  suffix?: string
  warn?: boolean
  full?: string
}

/** Short human titles for row groups (rendered as mini section headers). */
export const GROUP_TITLES: Record<RowGroup, string> = {
  identity: "ID",
  workspace: "WORKSPACE",
  environment: "ENVIRONMENT",
  resources: "RESOURCES",
}

/** Group display order. */
export const GROUP_ORDER: RowGroup[] = ["identity", "workspace", "environment", "resources"]

export type SandboxSnapshot = {
  name: string
  idFull: string | null
  idShort: string | null
  ws: string | null
  /** Workspace mode: "mounted" when the workspace dir is (under) a host
   * bind mount — writes persist on the host; "cloned" when it lives inside
   * the container only. Mirrors the launcher's mounted-vs-`-clone` split. */
  mode: "mounted" | "cloned"
  mounts: string[]
  kits: string[]
  repos: string[]
  dlEnv: string | null
  dind: boolean
  mcpGateway: boolean
  creds: Record<string, string>
  os: string | null
  kernel: string | null
  containerId: string | null
}

/** Sandbox workspace mode. "mounted" when the workspace dir is the host
 * bind mount itself or sits under one (host virtiofs mounts from
 * /proc/mounts) — writes persist on the host. "cloned" when the workspace
 * lives inside the container only (the launcher's -clone semantics). */
export function workspaceMode(ws: string | null, mounts: string[]): "mounted" | "cloned" {
  if (ws && mounts.some((m) => ws === m || ws.startsWith(`${m}/`))) return "mounted"
  if (mounts.length > 0 && !ws) return "mounted"
  return "cloned"
}

/** One-time probe of everything that cannot meaningfully change while the
 * TUI runs. Returns null when the environment does not look like a sandbox
 * (fails closed: no card). */
export function probeStatic(): SandboxSnapshot | null {
  const name = envGet("SANDBOX_NAME")
  if (!name) return null
  const idFull = envGet("SANDBOX_ID")
  let containerId: string | null = null
  try {
    const cgroup = readText("/proc/self/cgroup")
    // cgroup v2: "0::/docker/<64-hex-id>"
    const m = /^0::\/docker\/([0-9a-f]{12,64})/m.exec(cgroup ?? "")
    containerId = m?.[1]?.slice(0, 12) ?? null
  } catch {
    /* cosmetic — skip */
  }
  const mounts = hostMounts()
  const ws = envGet("WORKSPACE_DIR")
  return {
    name,
    idFull,
    idShort: idFull ? idFull.slice(0, 8) : null,
    ws,
    mode: workspaceMode(ws, mounts),
    mounts,
    kits: kitNames(),
    repos: repoDirs(ws),
    dlEnv: envGet("OC_DL_ENV"),
    dind: dockerSocket(),
    mcpGateway: mcpGateway(),
    creds: credentialModes(),
    os: osPretty(),
    kernel: kernelRelease(),
    containerId,
  }
}

/** Polled values: disk (smart: the workspace mount's filesystem when the
 * workspace is mounted, the container overlay otherwise), memory, load,
 * uptime. */
export function probeDynamic(snap?: SandboxSnapshot): {
  disk: string | null
  diskWarn: boolean
  diskFull: string | null
  mem: string | null
  memWarn: boolean
  load: string | null
  up: string | null
} {
  const diskTarget = snap && snap.mode === "mounted" ? snap.ws ?? "/" : "/"
  const disk = diskUsageFor(diskTarget) ?? diskUsage()
  const mem = memoryUsage()
  const load = loadAvg()
  const up = uptimeSeconds()
  return {
    disk: disk ? `${humanKiB(disk.usedKiB)} / ${humanKiB(disk.totalKiB)}` : null,
    diskWarn: disk ? disk.usedKiB / disk.totalKiB > 0.85 : false,
    diskFull: disk ? `${diskTarget}: ${humanKiB(disk.usedKiB)} used of ${humanKiB(disk.totalKiB)}` : null,
    mem: mem ? `${humanKiB(mem.usedKiB)} / ${humanKiB(mem.totalKiB)}` : null,
    memWarn: mem ? mem.usedKiB / mem.totalKiB > 0.9 : false,
    load: load ? `${load.l1.toFixed(2)} ${load.l5.toFixed(2)} ${load.l15.toFixed(2)}` : null,
    up: up !== null ? humanUptime(up) : null,
  }
}

/** Compact status subline rendered under the sandbox name: workspace mode +
 * uptime, e.g. "cloned · up 2h 55m". */
export function sublineText(snap: SandboxSnapshot, dyn: ReturnType<typeof probeDynamic>): string {
  const parts: string[] = [snap.mode]
  if (dyn.up) parts.push(`up ${dyn.up}`)
  return parts.join(" · ")
}

/** Build the visible rows from a snapshot + dynamic probe. Rows whose data is
 * unavailable are simply absent. Identity (mode, uptime) lives in the card's
 * subline; deep detail (mounts, os, container id) lives in the click toast
 * (detailText) — the card stays scannable.
 *
 * `valueAvail` (columns available for the value cell) makes rows width-aware:
 * long values truncate and repo lists shrink to what fits, with overflow
 * counted in `suffix`. Omit (Infinity) for no fitting (used by tests). */
export function buildRows(snap: SandboxSnapshot, dyn: ReturnType<typeof probeDynamic>, valueAvail = Infinity): Row[] {
  // Fit helper: how many repos fit (joined with ", ") in the value area
  // (valueAvail), reserving room for the "+N" suffix? Shows up to 3 full
  // names; when even one full name does not fit, the name is tail-clamped
  // ("even… +4") so repo names stay recognizable.
  const fitRepos = (): { value: string; suffix?: string } => {
    const repos = snap.repos
    for (let n = Math.min(repos.length, 3); n >= 1; n--) {
      const value = repos.slice(0, n).join(", ")
      const hidden = repos.length - n
      const suffix = hidden > 0 ? `+${hidden}` : undefined
      const room = value.length + (suffix ? suffix.length + 1 : 0)
      if (room <= valueAvail) return { value, suffix }
    }
    const hidden = repos.length - 1
    const keep = Math.max(4, valueAvail - (hidden > 0 ? hidden.toString().length + 3 : 2))
    return { value: `${repos[0].slice(0, keep)}…`, suffix: hidden > 0 ? `+${hidden}` : undefined }
  }

  const budget = (suffix?: string) => Math.max(4, valueAvail - (suffix ? suffix.length + 1 : 0))

  const rows: Row[] = []
  if (snap.idShort) {
    rows.push({ key: "id", label: "id", group: "identity", value: snap.idShort, full: snap.idFull ?? snap.idShort })
  }
  if (snap.ws)
    rows.push({
      key: "ws",
      label: "ws",
      group: "workspace",
      value: clampMiddle(snap.ws, budget()),
      full: snap.ws,
    })
  if (snap.repos.length > 0) {
    const fit = fitRepos()
    rows.push({
      key: "repos",
      label: "repos",
      group: "workspace",
      value: fit.value,
      suffix: fit.suffix,
      full: `workspace directories:\n  ${snap.repos.join("\n  ")}`,
    })
  }
  if (snap.dlEnv)
    rows.push({
      key: "dl",
      label: "env",
      group: "environment",
      value: snap.dlEnv,
      full: `OC_DL_ENV=${snap.dlEnv} (environment hint provided by the launcher)`,
    })
  if (snap.kits.length > 0) {
    rows.push({
      key: "kits",
      label: "kits",
      group: "environment",
      value: `${snap.kits.length}`,
      full: snap.kits.join("\n"),
    })
  }
  const caps = [snap.dind ? "docker" : null, snap.mcpGateway ? "mcp" : null].filter((c): c is string => !!c)
  if (caps.length > 0) {
    rows.push({
      key: "caps",
      label: "caps",
      group: "environment",
      value: caps.join(", "),
      full: [snap.dind ? "docker-in-docker: nested daemon available" : null, snap.mcpGateway ? "MCP gateway configured" : null]
        .filter((l): l is string => !!l)
        .join("\n"),
    })
  }
  if (Object.keys(snap.creds).length > 0) {
    const active = Object.entries(snap.creds).filter(([, v]) => v && v !== "none")
    rows.push({
      key: "creds",
      label: "creds",
      group: "environment",
      value: active.length > 0 ? active.map(([k]) => k.toLowerCase()).join(", ") : "none",
      full: Object.entries(snap.creds)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n"),
    })
  }
  if (dyn.disk)
    rows.push({
      key: "disk",
      label: "disk",
      group: "resources",
      value: dyn.disk,
      warn: dyn.diskWarn,
      full: dyn.diskFull ?? `filesystem: ${dyn.disk}`,
    })
  if (dyn.mem)
    rows.push({
      key: "mem",
      label: "mem",
      group: "resources",
      value: dyn.mem,
      warn: dyn.memWarn,
      full: `memory: ${dyn.mem} (sandbox view of the VM)`,
    })
  if (dyn.load)
    rows.push({
      key: "load",
      label: "load",
      group: "resources",
      value: dyn.load,
      full: `load average: ${dyn.load}`,
    })
  return rows
}

/** Full detail text for the click toast — everything, including the facts
 * dropped from the card to keep it scannable (mounts, os, container id). */
export function detailText(snap: SandboxSnapshot, dyn: ReturnType<typeof probeDynamic>): string {
  const lines = [
    `sandbox: ${snap.name}`,
    snap.idFull ? `id: ${snap.idFull}` : null,
    snap.mode === "mounted"
      ? "mode: mounted (host bind mount — writes persist on the host)"
      : "mode: cloned (in-container workspace — no host writes)",
    dyn.up ? `uptime: ${dyn.up}` : null,
    snap.ws ? `workspace: ${snap.ws}` : null,
    snap.repos.length > 0 ? `workspace directories: ${snap.repos.join(", ")}` : null,
    snap.mounts.length > 0 ? `host mounts:\n  ${snap.mounts.join("\n  ")}` : "host mounts: none",
    snap.dlEnv ? `OC_DL_ENV: ${snap.dlEnv}` : null,
    snap.kits.length > 0 ? `kits: ${snap.kits.join(", ")}` : null,
    snap.dind ? "docker-in-docker: yes" : "docker-in-docker: no",
    snap.mcpGateway ? "mcp: gateway configured" : null,
    Object.keys(snap.creds).length > 0
      ? `credential modes: ${Object.entries(snap.creds)
          .map(([k, v]) => `${k.toLowerCase()}=${v}`)
          .join(", ")}`
      : null,
    dyn.disk ? `disk: ${dyn.diskFull ?? dyn.disk}` : null,
    dyn.mem ? `memory: ${dyn.mem}` : null,
    dyn.load ? `load average: ${dyn.load}` : null,
    snap.os ? `os: ${snap.os}${snap.kernel ? ` (kernel ${snap.kernel})` : ""}` : null,
    snap.containerId ? `container: ${snap.containerId}` : null,
  ]
  return lines.filter((l): l is string => !!l).join("\n")
}
