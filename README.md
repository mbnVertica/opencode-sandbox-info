# opencode-sandbox-info

An [OpenCode](https://opencode.ai) (V2) TUI plugin that adds a sidebar card
showing facts about the [Docker Sandbox](https://docs.docker.com) the
terminal is running in.

Everything shown is read **from inside the sandbox itself** — environment
variables, `/proc`, `/etc` — no host calls, no network requests, no
telemetry. The credential-related rows show **configuration modes only,
never secret values** (details in [Data it reads](#data-it-reads--and-what-it-deliberately-does-not)).

Tested against OpenCode 2.0.20. Works with any setup that sets Docker
Sandboxes' `SANDBOX_NAME` environment variable (the standard `sbx` agent
sessions do).

## The card

```
╭─────── SANDBOX ───────╮
│ ⬢ acme-corp-dev       │
│ cloned · up 2h 55m    │
│ ID                    │
│ id:     47f85b8a      │
│ WORKSPACE             │
│ ws:  …gent/workspace  │
│ repos: acme-webshop +4│
│ ENVIRONMENT           │
│ kits:         5       │
│ caps:   docker, mcp   │
│ creds: acme, github   │
│ RESOURCES             │
│ disk:  4.7G / 19.5G   │
│ mem:   1.1G / 31.1G   │
│ load: 0.02 0.01 0.01  │
╰───────────────────────╯
```

The card fills the sidebar width exactly: it never clips on narrow panels
and never leaves dead space on wide ones. Labels sit in a fixed muted left
column ending with `:` and cannot wrap; the value cell flexes to the
remaining width and centers its value. Groups get small section headers
(`ID`, `WORKSPACE`, `ENVIRONMENT`, `RESOURCES`). Full details (mounts, os,
kernel, container id, all kit and credential names) are a click away.

- **id** — `SANDBOX_ID` (matches the `id` field of `sbx ls --json`)
- **ws** — `WORKSPACE_DIR` (mounted host dir, or the in-sandbox workspace)
- **repos** — directories in the workspace (hidden when none)
- **kits** — kit count from the sandbox startup manifest, when present
- **caps** — capabilities: `docker` (nested daemon), `mcp` (gateway configured)
- **creds** — credential injections that are active (full modes in toast)
- **disk** — the workspace mount's filesystem when mounted, the container
  overlay otherwise (polled every 60s; warns past 85%)
- **mem** — memory in use vs total, sandbox view (warns past 90%)
- **load** — 1/5/15-minute load averages

The subline under the name shows the workspace mode (`mounted` = writes
persist on the host / `cloned` = in-container) and uptime.

**Getting more detail:** click the card for a toast with full, untruncated
details (all repo names, host mounts, kit names, credential modes, OS +
kernel, container id). Hovering (holding the mouse over) the card reveals
per-row tooltips — each row's label/value pair has its own longer
explanation, e.g. the exact mounted path behind a truncated `ws` value or
which providers are behind `creds`. Individual rows are also clickable.

## Install

Run **where opencode runs**: on your host for normal sessions, or *inside
the sandbox* for sandboxed sessions (each sandbox has its own filesystem;
a plugin installed on the host is not visible inside the sandbox):

```sh
opencode plugin add github:mbnVertica/opencode-sandbox-info
```

That's the whole install — the UI dependencies (`@opentui/*`, `solid-js`)
are **not** installed into the plugin folder on purpose: they are declared
as optional peer dependencies and resolve from the OpenCode installation
itself, so the plugin shares the exact same `solid-js` instance as the host
TUI. (Installing a second copy inside the plugin folder is what caused the
"card renders but never updates" bug — see Troubleshooting.)

The card appears in the running TUI without a restart — OpenCode reloads
plugins automatically. If it does not show up immediately, reopening the
TUI (or `opencode service restart`) picks it up.

To pin a specific release instead of following `main`, append the tag:
`opencode plugin add github:mbnVertica/opencode-sandbox-info#v1.0.11`.

### Behavior outside sandboxes

The plugin is **fully inert** unless the opencode process has `SANDBOX_NAME`
in its environment. On a host machine, or in any non-sandboxed session, it
loads, does nothing, and the stock sidebar is untouched — safe to install
unconditionally.

## Uninstall

```sh
opencode plugin remove github:mbnVertica/opencode-sandbox-info
```

The card disappears from the running TUI automatically. (For manually
cloned copies: delete
`~/.config/opencode/plugins/opencode-sandbox-info` — the plugin watches
the config directory and unloads.)

## Troubleshooting

- **Card renders but never updates** (uptime stuck; a click-toast shows a
  newer value) — there is a second copy of `solid-js` inside the plugin
  folder. Solid's reactive graph is per-copy module state, so a signal
  updated through one copy never triggers render effects built on the
  other; the card only repaints on remount (e.g. switching sessions). Fix
  in the sandbox:

  ```sh
  # one-time: make sure the parent config dir provides the UI deps
  cd ~/.config/opencode && npm install --no-audit --no-fund
  # then drop the plugin-local duplicate
  rm -rf ~/.config/opencode/plugins/opencode-sandbox-info/node_modules
  ```

  Restart the TUI afterwards. Order matters: parent install first, then the
  delete — reversed, the card disappears instead of freezing.

- **Card missing after `plugin add`** — give the TUI a moment (the server
  reconciles plugins asynchronously); if it still does not show, reopen
  the TUI or run `opencode service restart`. Also run the self-check
  inside the sandbox to see what the plugin would show:

  ```sh
  cd ~/.config/opencode/plugins/opencode-sandbox-info   # or the package install path
  node selfcheck.ts
  ```

- **`plugin add` fails with a git/network error** — the sandbox needs
  egress to `github.com` + `codeload.github.com` (and `registry.npmjs.org`
  for dependencies). On restricted sandboxes, see below.
- **`self-signed certificate in certificate chain` during install** — the
  network is TLS-intercepted; trust the proxy's root CA in the sandbox
  before installing.

## Restricted / offline sandboxes

If the sandbox cannot reach GitHub, install the plugin from the host
instead. The plugin is a handful of source files; dependencies are usually
resolved by OpenCode at runtime, so a file copy is often all that is
needed:

1. Clone the repo on any machine with network access.
2. Copy the cloned folder into the sandbox's plugin directory
   (`~/.config/opencode/plugins/opencode-sandbox-info`) using whatever
   host→sandbox copy mechanism your setup provides (for Docker Sandboxes:
   `sbx cp <folder> <sandbox>:/home/agent/.config/opencode/plugins/`).
3. Restart OpenCode in the sandbox.

If the card still does not appear, the sandbox lacks the UI dependencies
(`@opentui/*`, `solid-js`) that OpenCode resolves at runtime. Install them
**one level up** — into the opencode config directory, never into the
plugin folder (a plugin-local copy breaks reactive updates, see
Troubleshooting):

```sh
cd ~/.config/opencode && npm install --no-audit --no-fund
```

## Sandbox provisioning (kits/mixins)

If you provision sandboxes declaratively (kit references in `sbx create`
or `sbxenv.yaml` `kits:` lists), this repository includes a ready-made
mixin: `kit/`. Adding it to a sandbox ships the plugin into
`~/.config/opencode/plugins/opencode-sandbox-info/` and ensures the shared
UI dependencies exist at the parent config level
(`~/.config/opencode/node_modules`) — never inside the plugin folder.

The kit install needs `registry.npmjs.org` access at creation time and a
trusted TLS path to it (on TLS-intercepted networks, layer it after your
CA-trust kit).

## Data it reads — and what it deliberately does not

The plugin only polls data available **inside the sandbox itself**. It
makes **no external connections, no network requests, no host calls, and
no telemetry** — at install time it is a plain npm dependency fetch, and at
runtime it reads a fixed, closed list of files and environment variables
(verified: exactly the entries in the table below).

### Credentials and secrets: modes, never values

The `creds` row deserves special attention because it *sounds* sensitive
and is not. Docker Sandboxes injects credentials through the proxy and
publishes, for each provider, a separate **mode descriptor** variable that
says *how* a credential is wired — never the credential itself:

```
SBX_CRED_ACME_MODE=apikey        ← what the plugin reads (a mode name)
GH_TOKEN=gho_…                   ← the actual secret (never read)
ACME_API_KEY=…                   ← the actual secret (never read)
```

The plugin matches **only** variables named `SBX_CRED_<PROVIDER>_MODE` and
displays the provider name and the mode word (`apikey`, `none`, …). It
never reads, stores, displays, or transmits:

- any variable whose value could be a secret (`*_KEY`, `*_TOKEN`,
  `*_SECRET`, `GH_TOKEN`, …)
- file contents under credential directories
- anything from the nested Docker daemon or the MCP gateway beyond the
  fact that a gateway URL is configured

The same principle applies to everything else in the table: values are
paths, counts, sizes, durations, and mode words — operational metadata,
not content. The workspace `repos` row lists directory **names** only
(never file contents); the `container id` is the local cgroup path
segment; `df`/`/proc/meminfo`/`/proc/loadavg` are kernel counters.

For full transparency, the complete set of files and environment variables
touched is enumerable from the source (`data.ts`, ~650 lines) — the table
below is that list:

| What | Source |
|---|---|
| sandbox name / id | `SANDBOX_NAME`, `SANDBOX_ID` env |
| workspace mode | `/proc/mounts` vs `WORKSPACE_DIR` (`mounted` / `cloned`) |
| workspace dir | `WORKSPACE_DIR` env |
| repos | directory listing of the workspace (names only) |
| env hint | `OC_DL_ENV` env (only shown when set — a convention some launchers use to pass an environment name) |
| host mounts | `/proc/mounts` (device/path/type columns only) |
| kits | `/etc/durable-startup.d/manifest.json` (when present) |
| docker-in-docker | existence check of the sandbox's own docker socket (no daemon queries) |
| mcp gateway | existence of `MCP_GATEWAY_URL` env (not its value) |
| credential modes | `SBX_CRED_*_MODE` env keys (mode words only — never secret values, see above) |
| container id | `/proc/self/cgroup` (toast only) |
| OS / kernel | `/etc/os-release`, `/proc/sys/kernel/osrelease` |
| disk / mem / load / uptime | `df -k`, `/proc/meminfo`, `/proc/loadavg`, `/proc/uptime` (polled, 60s) |

No other files are read, no other environment variables are inspected, and
the values above never leave the terminal — the card renders them locally
and the click toast is a local UI element, not a network call.

## How it works

`data.ts` is a UI-free probe layer (env, `/proc`, `/etc`); `tui.tsx` is the
SolidJS card that claims an `append: "sidebar.footer"` slot (bottom of the
sidebar, under the stock content). File access
goes through `process.getBuiltinModule` so the same code runs under the
OpenCode TUI's Bun runtime and plain Node (for `selfcheck.ts`). Every probe
fails closed: missing data hides its row instead of breaking the card.

## License

MIT
