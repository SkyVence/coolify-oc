# @skyvence/coolify-oc

Deploy and configure projects on a self-hosted [Coolify](https://coolify.io)
instance from OpenCode. Adds a **Coolify section to the sidebar** and **21 tools**
the model can use to inspect, deploy and configure your applications.

## Install

```sh
cd ~/.config/opencode && bun add @skyvence/coolify-oc

mkdir -p plugins/coolify-oc
printf 'export { default } from "@skyvence/coolify-oc"\n'     > plugins/coolify-oc/index.ts
printf 'export { default } from "@skyvence/coolify-oc/tui"\n' > plugins/coolify-oc/tui.ts
cat > plugins/coolify-oc/package.json <<'EOF'
{ "name": "coolify-oc-discovery", "type": "module", "exports": { ".": "./index.ts", "./tui": "./tui.ts" } }
EOF
```

> The shim's `name` must **not** be `@skyvence/coolify-oc`. A package that
> imports a specifier matching its own name resolves to *itself*, so the shim
> would import the shim. Any other name works; this one is only a label.

Restart the TUI, run `/coolify`, choose **Set up instance**, and enter your
Coolify URL and API token.

<details>
<summary>Per project instead</summary>

OpenCode 2.0.10 does not load plugins listed only in the global
`opencode.jsonc`. A project-local entry does work:

```jsonc
{
  "plugins": [
    { "package": "@skyvence/coolify-oc", "options": { "endpoint": "https://coolify.example.com" } }
  ]
}
```

</details>

## Use

| Command | What it does |
| --- | --- |
| `/coolify` | Opens the sidebar actions: map this project, map with the model, set up instance, show every application. |
| `/coolify-map` | Resolves this repository against Coolify and writes `coolify.json`. No model turn. |
| `/coolify-deploy` | Deploys in a **background tab**, so the current conversation keeps running. |

The sidebar shows the instance, the token's level of access, and one row per
application with a status light, a compact state and a refresh countdown.
Clicking a row offers Deploy, Logs, Restart and Roll back.

## Configuration

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `endpoint` | string | — | Your Coolify base URL. `https://host`, `host` and `https://host/api/v1` all work. |
| `refreshSeconds` | integer 5–600 | `25` | Sidebar cadence. Automatically faster while a deployment or restart is in flight. |

The API token is stored by OpenCode as a credential, never in configuration.
`COOLIFY_ENDPOINT` is used when no `endpoint` option is set.

## `coolify.json`

Commit this at a repository root to map the repo — and each package in a
monorepo — to Coolify resources:

```jsonc
{
  "projectUUID": "proj_uuid",
  "environmentName": "production",
  "serverUUID": "srv_uuid",
  "applicationUUID": "app_uuid",              // shorthand for a single-app repo
  "applications": {
    "web": { "applicationUUID": "web_uuid", "path": "apps/web" },
    "api": { "applicationUUID": "api_uuid", "path": "apps/api" }
  },
  "databases": {
    "postgres": { "databaseUUID": "pg_uuid", "type": "postgresql", "path": "apps/api" }
  }
}
```

- Discovery walks **down** from the repository root (4 levels), skipping
  `node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`, `.turbo` and
  `vendor`. **Each config gets its own sidebar section.**
- `path` is repo-relative and the longest match wins, so `apps/web/admin`
  resolves the `apps/web` entry.
- Lookup order: `coolify.json` → a pinned link → matching the git remote, then
  the directory name against `GET /applications`.
- The tools can write it for you: `coolify_configure_project`, or **Map this
  project** in the sidebar.

## Tools

21 tools in the `coolify` namespace, each on one permission tier.

| Tool | Tier | Purpose |
| --- | --- | --- |
| `capabilities` | read | What the token may do, and the evidence for each verdict. |
| `resolve` | read | Find the application that already deploys this project. |
| `link` / `unlink` | write | Pin or forget an application locally. |
| `status` | read | One application's runtime state and latest deployment. |
| `list_resources` | read | Projects, applications, servers, destinations, environments. |
| `deployment_status` | read | One deployment by UUID, with a log tail. |
| `plan_application` | read | Propose build pack, port and base directory from the checkout. |
| `application` | read | `settings`, `envs` (names only), `logs`, `deployments`, `rollback_images`, `storages`. |
| `databases` / `database` | read | Every database; then one database's `backups`, `executions`, `storages`. |
| `project` | read | `get`, `environments`, `resources`. |
| `configure_project` | write | Create or update `coolify.json`. |
| `application_update` | write | `settings`, `env_set`, `env_unset`, `env_sync`, `storage_create`. |
| `create_application` | write | From public git, deploy key, GitHub App, Dockerfile or image. Records the result. |
| `create_database` | write | Provision postgres, mysql, mariadb, mongo, redis, keydb, clickhouse or dragonfly. |
| `database_manage` | write | `backup_create`, `backup_update`, `backup_trigger`, `storage_create`, `storage_update`. |
| `project_manage` | write | `create`, `environment_create`. |
| `deploy` | deploy | `deploy`, `cancel`, `rollback`, `start`, `stop`, `restart`. |
| `destroy` | destructive | Every delete, plus `migrate_*` and `move_*`. Requires explicit UUIDs. |
| `env_value` | secrets | Read one environment variable's value. The only tool that returns a secret. |

## Permissions

Five actions: `coolify.read`, `coolify.write`, `coolify.deploy`,
`coolify.destructive`, `coolify.secrets`.

Every call **asks by default**. A `deny` rule removes the tool from the model's
view rather than letting it fail:

```jsonc
{
  "permissions": [
    { "action": "coolify.read", "resource": "*", "effect": "allow" },
    { "action": "coolify.destructive", "resource": "*", "effect": "ask" }
    // deny coolify.secrets to keep environment values away from the model entirely
  ]
}
```

Environment values never appear in listings. `env_value` is the only path that
returns one, and `env_sync` pushes a `.env` file server-side so values reach
Coolify without entering the conversation.

## Development

```sh
bun install
bun run check   # tsc --noEmit + vitest
bun run test
```

## Limitations

- Coolify **servers and destinations must already exist**. Projects,
  applications and databases can be created.
- `rollback`, `migrate_*`, `move_*` and the storage and backup verbs have not
  been exercised against a live instance — they are covered by mocked tests only.
- `GET /databases` does not report a project or environment, so a database cannot
  always be attributed to a project.
- A Coolify API token's abilities are probed, not reported: nothing in the API
  exposes them, so `capabilities` shows the evidence for each verdict.
