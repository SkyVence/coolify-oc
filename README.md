# @skyvence/coolify-oc

An OpenCode V2 plugin that deploys and configures projects on a self-hosted
[Coolify](https://coolify.io) instance — from the model, through tools, and from
the terminal, through a TUI panel.

One package ships both halves:

| Entry    | Half          | Responsibility                                                        |
| -------- | ------------- | --------------------------------------------------------------------- |
| `.`      | Server plugin | Holds the API token, probes abilities, registers tools and RPC.        |
| `./tui`   | TUI plugin    | Slash commands, dialogs, and a session panel. Never touches Coolify.  |
| `./rpc`   | Contract      | The typed boundary the two halves agree on.                            |

The TUI talks to the server over RPC, so the API token never reaches the
terminal and the panel still works against a remote server.

## Install

OpenCode loads plugins from `opencode.json(c)` **per location**, and (as of
2.0.10) it does **not** load plugins listed only in the global
`~/.config/opencode/opencode.jsonc`. There are therefore two ways to install,
and only the first one gives you the plugin in every project.

### Installing it for you

Paste this into OpenCode. It does the whole install and then proves it worked:

```text
Install the @skyvence/coolify-oc plugin for me.

1. Add it to my OpenCode config directory:
     cd ~/.config/opencode && bun add @skyvence/coolify-oc
   (use npm if bun is unavailable)
2. Create the discovery directory ~/.config/opencode/plugins/coolify-oc/
   with three files:
   - index.ts      -> export { default } from "@skyvence/coolify-oc"
   - tui.ts        -> export { default } from "@skyvence/coolify-oc/tui"
   - package.json  -> { "name": "@skyvence/coolify-oc", "type": "module",
                        "exports": { ".": "./index.ts", "./tui": "./tui.ts" } }
3. Verify it loaded by running, from any project directory:
     opencode api post /api/rpc/coolify/capabilities --standalone --data '{"input":{}}'
   A JSON object means it worked. "rpc.unavailable" means it did not.
4. If step 3 fails, the bare specifier did not resolve from the discovery
   directory. Rewrite index.ts and tui.ts to import from the absolute path of
   the installed package instead, and verify again.
5. Tell me to restart the TUI, then to run /coolify to set the instance URL and
   API token.
```

That works because OpenCode 2.0.10 does **not** load plugins listed only in the
global `opencode.jsonc`; the discovery directory is the path that does load
globally. Step 4 exists because bare-specifier resolution from that directory is
the one part not verified on every platform.

### Manual install

If you would rather not involve the model, the same steps by hand:

```sh
cd ~/.config/opencode && bun add @skyvence/coolify-oc
mkdir -p plugins/coolify-oc
printf 'export { default } from "@skyvence/coolify-oc"\n' > plugins/coolify-oc/index.ts
printf 'export { default } from "@skyvence/coolify-oc/tui"\n' > plugins/coolify-oc/tui.ts
cat > plugins/coolify-oc/package.json <<'EOF'
{ "name": "@skyvence/coolify-oc", "type": "module", "exports": { ".": "./index.ts", "./tui": "./tui.ts" } }
EOF
```

### A. Global (recommended)

Use OpenCode's plugin discovery layout, where a plugin lives in its own folder
under the global config directory:

```text
~/.config/opencode/plugins/coolify-oc/
├── index.ts        # re-exports the server half
├── tui.ts          # re-exports the TUI half
└── package.json    # exports { ".": "./index.ts", "./tui": "./tui.ts" }
```

Create that folder with three files that point at this package:

```ts title="~/.config/opencode/plugins/coolify-oc/index.ts"
export { default } from "/absolute/path/to/opencode-coolify/src/index"
```

```ts title="~/.config/opencode/plugins/coolify-oc/tui.ts"
export { default } from "/absolute/path/to/opencode-coolify/src/tui"
```

```json title="~/.config/opencode/plugins/coolify-oc/package.json"
{
  "name": "@skyvence/coolify-oc",
  "type": "module",
  "exports": { ".": "./index.ts", "./tui": "./tui.ts" }
}
```

Both halves then load in every project. Because discovery cannot carry plugin
options, configure it from the TUI or the environment:

- endpoint — `/coolify-endpoint`, or `COOLIFY_ENDPOINT`
- token — `/coolify-connect`

`refreshSeconds` is a plugin option, so it needs the per-project form below;
discovery cannot carry it. The default is `25`.

The endpoint is stored in plugin storage, so it survives restarts and applies to
every project.

### B. Per project

Add the plugin to `opencode.jsonc` in the project that should be able to deploy:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-coolify",
      "options": {
        "endpoint": "https://coolify.example.com",
        // How often the sidebar polls while nothing is in flight, in seconds.
        "refreshSeconds": 25
      }
    }
  ]
}
```

`https://host`, `host`, and `https://host/api/v1` are all accepted; the plugin
normalizes to `<origin>/api/v1`. The TUI half is loaded automatically for any
plugin in `opencode.json(c)` that exposes `./tui`.

`refreshSeconds` must be an integer between `5` and `600`; anything else is
ignored and the default of `25` is used. While a deployment or restart is in
flight the sidebar polls faster than the configured idle cadence regardless.

Do not configure the same plugin globally **and** per project — it would load
twice.

### Endpoint precedence

1. the `endpoint` plugin option
2. the `COOLIFY_ENDPOINT` environment variable
3. the value saved by `/coolify-endpoint`

### Connect a token

In Coolify, create a token under *Keys & Tokens → API tokens*, then run
`/coolify-connect` in the TUI. The token is stored by OpenCode as a `key`
credential on the plugin's `coolify` integration.

On a self-hosted instance, API access must also be enabled in Coolify settings,
otherwise every request returns `403`.

Then verify with `/coolify` or the `coolify_capabilities` tool.

## What the key can do

Coolify issues tokens with one of `read`, `read:sensitive`, `write`, `deploy`,
or `root`. Two consequences shape this plugin:

- **No endpoint reports a token's abilities.** The plugin probes instead.
- **A `deploy`-only token cannot read projects at all**, so resource discovery is
  impossible with it.

So the plugin resolves abilities two ways.

### 1. Active probing (`src/coolify/capabilities.ts`)

Each ability is isolated by a request that can only succeed if the permission
check passed. Coolify's permission middleware runs before the controller, so a
`403` is proof of absence and *any other* status means the ability is present:

| Ability  | Probe                                    | Granted when            |
| -------- | ---------------------------------------- | ----------------------- |
| `read`   | `GET /projects`                          | anything but `403`      |
| `write`  | `DELETE /applications/<sentinel-uuid>`   | anything but `403`      |
| `deploy` | `POST /deploy?uuid=<sentinel-uuid>`      | anything but `403`      |
| `read:sensitive` | lazily, from a "Missing sensitive permission" `403` | — |

The `write` and `deploy` probes target `opencode-probe-00000000-...`, a UUID
that cannot exist, so a "granted" verdict has **no side effect**. A `401` is
never treated as a verdict about abilities — it is raised, because an invalid
token is a different problem.

`read:sensitive` is deliberately left `unknown` rather than guessed, since
Coolify publishes no redaction sentinel.

### 2. Reactive learning

If a probe is inconclusive and a real request returns `403`, the client reports
the missing ability back to the plugin, which records it, re-registers tools,
and emits `capabilities.changed`. The system converges on the truth from real
traffic, so a wrong probe cannot keep a broken tool in front of the model.

### 3. Gating

Tools are registered through `ctx.tool.transform` and rebuilt on every change,
so the model only ever sees operations the key can actually perform:

| Tools                                | Requires                |
| ------------------------------------ | ----------------------- |
| `capabilities`, `resolve`, `link`, `unlink` | nothing (local only) |
| `status`, `list_resources`, `deployment_status` | `read`        |
| `update_settings`                    | `write`                 |
| `deploy`, `cancel_deployment`         | `deploy`                |

When every probed ability passes, the report notes that this is *consistent
with* a `root` token. It is never claimed as confirmed, because Coolify offers
no way to confirm it.

## Finding an existing deployment

This is the answer to "the app was set up in the Coolify UI, not by this
plugin". Nothing needs to be re-created: the plugin looks for the deployment
that already exists, in precedence order.

1. **`coolify.json`** in the repository — the committed, monorepo-aware mapping.
   See [Repository config](#repository-config-coolifyjson). It wins over a pin
   because it is what the whole team gets.
2. **Pinned link** — stored by `coolify_link` or the popup's `l` action. Once
   resolved, the association is remembered, so later runs are instant.
3. **Discovery** — reads `remote.origin.url` and matches it against
   `GET /applications`.

Discovery scores each application and picks the best:

| Signal | Score | Notes |
| --- | --- | --- |
| git remote, exact | +100 | `git@github.com:o/r.git` vs `https://github.com/o/r` |
| git remote, path | +80 | Coolify's short `owner/repo` vs a full URL |
| directory name | +60 | normalized case and punctuation |
| partial name | +25 | either name contains the other |

The `path` tier exists because Coolify stores the short `owner/repo` form for
GitHub App deployments while a local checkout reports a full URL — comparing the
two verbatim never matches. A two-segment reference is compared against the tail
of the longer one; two full URLs on different hosts are still treated as
different.

A match is only accepted at `>= 60` and only when it is not tied. Otherwise the
candidates are returned with their scores and reasons, and the model asks you
which to use rather than guessing. If a pinned application has been deleted on
Coolify, the pin is reported and discovery resumes automatically.

Discovery needs the `read` ability. With a `deploy`-only token it cannot list
applications, so use a pinned link or a `coolify.json` instead.

## Repository config: `coolify.json`

`coolify.json` at the repo root is the recommended way to map a project — and
each package inside a monorepo — to Coolify resources. It is meant to be
committed, so everybody on the team resolves to the same place.

```jsonc
{
  "projectUUID": "proj_uuid",
  "environmentName": "production",
  "serverUUID": "srv_uuid",

  // Single-application repositories can use the shorthand instead of the map.
  "applicationUUID": "app_uuid",

  // Monorepos: one entry per application, keyed by a label you choose, with the
  // directory it owns.
  "applications": {
    "web": { "applicationUUID": "web_uuid", "path": "apps/web" },
    "api": { "applicationUUID": "api_uuid", "path": "apps/api", "name": "acme-api" }
  },

  // Databases, optionally scoped to a package. Omit `path` to make one visible
  // to every package.
  "databases": {
    "postgres": { "databaseUUID": "pg_uuid", "type": "postgresql", "path": "apps/api" },
    "redis": { "databaseUUID": "redis_uuid", "type": "redis" }
  }
}
```

Notes on the format:

- Entries may be a bare UUID string (`"api": "api_uuid"`) or an object.
- `uuid` and snake_case aliases (`project_uuid`, `application_uuid`,
  `database_uuid`) are accepted.
- `path` is repo-relative. Selection uses the **longest matching prefix**, so
  `apps/web/admin` still resolves the `apps/web` entry.
- When a monorepo's `applications` map has more than one entry and none owns the
  working directory, resolution stops and returns the candidates so the model
  asks which applies. It will not guess a package's application.

`coolify.json` takes precedence over a pinned link, because a checked-in mapping
is what the whole team gets. `.coolify.json` is also read, for compatibility with
the filename the official CLI has proposed in
[coollabsio/coolify-cli#85](https://github.com/coollabsio/coolify-cli/pull/85) —
that proposal uses `{ "context": "..." }` for instance selection, which is a
different concern and can share the file, since this plugin only reads a file
that actually contains one of its keys. The nearest file wins, and the search
never walks above the repository root.

## Runtime status

`Application.status` is a free-form string, typically `<state>:<health>` —
`running:healthy`, `running:unhealthy`, `restarting:unhealthy`, `exited`. The
API schema declares no enum, so `src/coolify/runtime.ts` parses it tolerantly:
`killed`/`dead`/`stopped` normalize to `exited`, a bare `unhealthy` becomes a
health verdict with no state, and anything unrecognized degrades to `unknown`
rather than being guessed at.

This drives the sidebar indicator and is reported by `coolify_status`
(`Runtime: running (healthy)`).

## Tools exposed to the model

21 tools in the `coolify` namespace, grouped by the kind of job rather than one
per endpoint. Tools in a group share a permission tier, so a group is the unit
you allow or deny.

| Tool | Tier | What it does |
| --- | --- | --- |
| `coolify_capabilities` | read | Which abilities the token has, and the evidence for each verdict. |
| `coolify_resolve` | read | Find the existing deployment, including the `coolify.json` mapping. |
| `coolify_status` | read | One application's runtime state and latest deployment. |
| `coolify_list_resources` | read | Projects, applications, servers, destinations, environments. |
| `coolify_deployment_status` | read | One deployment by UUID, with a log tail. |
| `coolify_plan_application` | read | Propose build pack, port and base directory for this repository. |
| `coolify_application` | read | `settings`, `envs` (names only), `logs`, `deployments`, `rollback_images`, `storages`. |
| `coolify_databases` | read | Every database with project, environment and runtime state. |
| `coolify_database` | read | `get`, `backups`, `backup_executions`, `storages`. |
| `coolify_project` | read | `get`, `environments`, `resources`. |
| `coolify_configure_project` | write | Create or update `coolify.json`. |
| `coolify_link` / `coolify_unlink` | write | Pin or forget an application for this project. |
| `coolify_application_update` | write | `settings`, `env_set`, `env_unset`, `env_sync`, `storage_create`. |
| `coolify_create_application` | write | Create from public git, deploy key, GitHub App, Dockerfile, or image — then record it. |
| `coolify_create_database` | write | Provision postgresql, mysql, mariadb, mongodb, redis, keydb, clickhouse or dragonfly. |
| `coolify_database_manage` | write | `backup_create`, `backup_update`, `backup_trigger`, `storage_create`, `storage_update`. |
| `coolify_project_manage` | write | `create`, `environment_create`. |
| `coolify_deploy` | deploy | `deploy`, `cancel`, `rollback`, `start`, `stop`, `restart`. |
| `coolify_destroy` | destructive | Every delete, plus `migrate_*` and `move_*`. Requires explicit UUIDs. |
| `coolify_env_value` | secrets | Read one environment variable's value. |

Creation never invents a credential: `private_deploy_key` and
`private_github_app` reference an existing key or GitHub App, which the plugin
lists but never creates.

`coolify_destroy` takes no defaults. Every action needs an explicit UUID, so a
misread prompt cannot delete the linked application.

## Permissions

Every tool declares one of five tiers, and the tier becomes a permission action:

| Action | Covers |
| --- | --- |
| `coolify.read` | everything that only inspects: status, resolve, logs, settings, databases, projects |
| `coolify.write` | settings and environment changes, creating applications and databases, projects |
| `coolify.deploy` | deploy, cancel, rollback, start, stop, restart |
| `coolify.destructive` | every delete, plus migrate and move |
| `coolify.secrets` | `coolify_env_value` — the only tool that returns a secret |

Behaviour comes from OpenCode, not from the plugin:

- **Every call prompts by default.** The runtime's default effect when no rule
  matches is `ask`, so nothing runs unattended unless you allow it.
- **`deny` removes the tool.** A rule with `effect: "deny"` and `resource: "*"`
  takes the tool out of what the model can see, rather than letting it fail at
  call time.

A suggested ruleset, allowing reads and keeping anything that changes
infrastructure asking:

```jsonc
{
  "permissions": [
    { "action": "coolify.read", "resource": "*", "effect": "allow" },
    { "action": "coolify.write", "resource": "*", "effect": "ask" },
    { "action": "coolify.deploy", "resource": "*", "effect": "ask" },
    { "action": "coolify.destructive", "resource": "*", "effect": "ask" },
    // Delete the next line to remove env-value reads from the model entirely.
    { "action": "coolify.secrets", "resource": "*", "effect": "ask" }
  ]
}
```

A token's own abilities gate independently, so a read-only token never sees the
mutating tools at all — the permission tiers only decide who approves them.

## Secrets

- Environment **listing** returns keys and flags only. Values never appear.
- `coolify_env_sync` pushes a `.env` file server-side, so values travel
  file→Coolify without entering the transcript; only counts are reported.
- `coolify_env_value` is the single tool that can return a value, and it is the
  one to deny.
- Logs sit on plain `coolify.read`. The tail is capped and labelled as possibly
  containing secrets.

## TUI

Two commands. Nothing else.

| Command | Behaviour |
| --- | --- |
| `/coolify` | Prompts for the instance URL and token only if they are missing, then opens the **panel** beside your chat. |
| `/coolify-deploy` | Starts the deployment in a **separate chat in a background tab**, so the current conversation keeps running. |

### The sidebar section

Everything is in the sidebar, so nothing covers the conversation:

```text
Coolify  Root Team
──────────────────────────────
token read write deploy secrets
──────────────────────────────
● lawn-web            running
◐ lawn-convex-backend running !
○ legacy              exited
+2 more · show all
──────────────────────────────
Configure
```

- **The title line** is the instance: the team name, the host, or `not connected`
  / `not configured`. It shows a spinner while a request is in flight and a
  countdown to the next automatic refresh. Clicking it refreshes now.
- **The token line** shows each ability in its own colour — green when granted,
  red when denied, grey when unknown — and the `token` label takes the tone of
  the whole line: green when all four are granted, amber when some are, red when
  none are.
- **Every `coolify.json` in the repository gets its own section.** If a repo has
  more than one — say `coolify.json` at the root and `apps/web/coolify.json` —
  the sidebar renders a section per config, headed by its repo-relative
  directory, each with its own rows and its own `show all`. Discovery walks down
  from the repository root, bounded to four levels, skipping `node_modules`,
  `.git`, `dist`, `build`, `.next`, `coverage`, `.turbo` and `vendor`, and never
  following symlinks. A malformed config is skipped rather than fatal. With a
  single config the section heading is omitted and it renders exactly as before.
- **Application rows** put the name and the state in separate elements, so a
  long name ellipsises without ever eating the state. The state is compact —
  `running`, `exited`, `not deployed` — and an unhealthy container is marked
  `running !`, because the status light already carries the colour. A row that
  is starting up replaces its status light with a spinner until it settles; this
  covers restarts this plugin did not trigger, such as one made in the Coolify
  UI, and the row polls faster until it is back. Hovering a row highlights it.
  Rows are capped at four; `+N more · show all` opens the whole project list.
- **`Configure`** is the single project-level entry point. It opens a list of
  the plugin's own actions, each of which then opens a **popup dedicated to that
  one action**:
  - *Map this project* — resolves the candidates for this directory and confirms
    or lets you pick, then writes `coolify.json`. No model turn.
  - *Map with the model* — opens the mapping prompt in a background tab, for a
    monorepo where choosing needs judgement.
  - *Set up instance* — a popup showing the current endpoint and token state with
    a button per setting, rather than asking for them one after the other.

Clicking an **application row** opens a popup with only that application's
actions: Deploy in a side chat, View logs, Restart, Roll back. Nothing
project-level appears there.

### Two ways to map a project

| Action | Needs a session? | What it does |
| --- | --- | --- |
| **Map this repository** | No | Resolves the candidates for the working directory and writes `coolify.json` directly. Deterministic, instant, no model turn. Asks you to confirm the match, or to pick when several are plausible. |
| **Map with the model** | No — it opens one | Runs the mapping prompt in a background tab. Use it for a monorepo, where deciding which package owns which application needs judgement. |

Neither requires a session to already be open: both create one in a background
tab when needed, the same way the deploy side chat does. (A Skill would not help
here — loading a skill itself requires a session, which is why the deterministic
path exists instead.)

### The deploy chat

The dialog's Deploy entry and `/coolify-deploy` do the same thing: create a
session titled `Deploy <app>` in the same working directory and open it in a
background tab.

That session is pre-allowed to **read** Coolify — listing applications, reading
settings, checking status — so it can investigate without interrupting you. It
still asks before deploying, changing settings, creating a database or deleting
anything; the tab shows a marker when it needs an answer. If tabs are turned off
in your settings, it says so and offers to run in the current chat instead.

### Gotcha: keymap layers cannot be registered from `setup`

`context.keymap.layer(...)` requires the TUI's Keymap provider, which does not
exist while `setup` runs. Calling it there throws `Keymap.Provider is missing`,
logs `plugin operation failed ... stage=setup`, and aborts the whole TUI plugin —
so no commands and no panel. Register the layer from a slot render instead:

```tsx
setup(context) {
  context.ui.slot({
    append: "app",
    render: () => {
      context.keymap.layer(() => ({ mode: "global", commands: [/* ... */] }))
      return null
    },
  })
}
```

Layers inside a component — the panel, for instance — are fine, because
components render inside the provider tree.

## Coolify endpoints used

`GET /team`, `GET /projects`, `GET /projects/{uuid}/environments`,
`GET /applications`, `GET|PATCH|DELETE /applications/{uuid}`,
`GET /applications/{uuid}/envs` (probe), `POST /deploy`, `GET /deployments`,
`GET /deployments/{uuid}`, `GET /deployments/applications/{uuid}`,
`POST /deployments/{uuid}/cancel`, `GET /servers`, `GET /destinations`.

## Development

```sh
bun install
bun run typecheck        # tsc --noEmit
bun run test             # vitest run

# Load the plugin from this directory and call its RPC directly:
opencode api post /api/rpc/coolify/capabilities --standalone --data '{"input":{}}'
opencode api get /api/integration --standalone     # shows the `coolify` integration
```

The RPC envelope is `{ "input": ... }`.

## Performance

The sidebar is the only thing here that polls, so it is the only thing worth
optimising, and three things keep it cheap:

- **Event reloads are trailing-debounced** (`EVENT_DEBOUNCE_MS`, 1.5s) and
  coalesced. A deployment emits `deploy.progress` every ~3s; reloading per event
  cost roughly 2,000–3,000 requests over a ten-minute deploy. Now a burst costs
  one request.
- **The cadence adapts.** `refreshSeconds` (default 25, range 5–600) while idle,
  10 seconds while any row's deployment is `queued`/`in_progress` or a restart
  is settling. The active cadence is always below the idle one.
- **Restarts are detected from the poll, not just from this plugin.** A row that
  was up and is now `starting`/`restarting`/`exited`, or whose deployment just
  went `in_progress`/`queued`, is followed with a spinner and the fast cadence,
  so a change made in the Coolify UI is picked up too. The flag clears when the
  row settles or after 3 minutes, whichever comes first.
- **One deployment-queue fetch per payload.** `latestDeploymentFor` takes a
  shared lazy getter, so a project whose applications have no per-app history no
  longer downloads the whole queue once per application.
- **Capability probing is single-flight with a 10-minute TTL.** Setting a token
  used to fire two identical probe bursts (six requests each), because both
  `credential.updated` and the TUI's own refresh ran.

Deliberately **not** done, and why:

- **Caching `GET` responses in the client.** A path allowlist would work, but the
  deployment wait loop polls `GET /deployments/{uuid}` for a state change — caching
  that would make it hang. Not worth the risk for the gain.
- **Memoizing `findProjectConfig`.** A TTL cache there would serve a stale config
  immediately after a write, which is precisely the "mapping did not appear" bug
  this README keeps describing. The debounce already cuts how often it runs.

## Publishing

The package is `@skyvence/coolify-oc`, scoped, with `publishConfig.access` set to
`public` so it does not publish as restricted:

```sh
npm login
npm publish
```

The scope has to exist on your npm account before the first publish — create the
`@skyvence` org or user scope in the npm UI, or the publish fails with a 403.
The checkout directory is still named `opencode-coolify`; that is cosmetic and
independent of the package name.

## Known limitations

- **Plugins in the global `opencode.jsonc` are not loaded** in OpenCode 2.0.10,
  even though the configuration reference lists `plugins` as a global field. Use
  the discovery layout or a per-project entry. This looks like a real
  inconsistency worth reporting.
- **There is no UI for choosing a project's endpoint globally** beyond the
  commands above; the endpoint is one instance for the whole machine.
- **`root` cannot be confirmed**, only inferred from all probes passing.
- **`read:sensitive` is detected lazily.** Setting it up front is possible via
  the unused `includeSensitive` probe option, but it guesses at Coolify's
  redaction format.
- **The write probe trusts middleware ordering.** If a future Coolify release
  ran resource lookup before the permission check, the probe could report a
  granted ability that later fails; reactive learning corrects this on first use.
- The `link` RPC cannot enrich application metadata without `read`.
- Nothing creates projects or applications yet. `create-public-application` and
  friends are the natural next step, ideally behind a confirmation.
