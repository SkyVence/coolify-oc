/** @jsxImportSource @opentui/solid */
import type { Integration } from "@opencode/plugin"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { normalizeDeploymentStatus } from "@skyvence/coolify-oc-shared/coolify/runtime"
import { runtimeTone, type RuntimeTone } from "@skyvence/coolify-oc-shared/coolify/runtime"
import { DEFAULT_REFRESH_SECONDS } from "@skyvence/coolify-oc-shared/options"
import { DEPLOY_SKILL, LINK_SKILL, type CoolifySkill } from "@skyvence/coolify-oc-shared/skills"
import {
  Coolify as CoolifyRpc,
  type ApplicationsPayload,
  type ApplicationsProjectPayload,
  type AppStatusPayload,
  type CapabilitiesPayload,
  type CandidatePayload,
  type DatabaseStatusPayload,
  type DeploymentLogPayload,
  type ResolvePayload,
} from "@skyvence/coolify-oc-shared/rpc"

const INTEGRATION_ID = "coolify" as Integration.ID
/**
 * The text-attribute bit flag for bold.
 *
 * Inlined rather than imported from `@opentui/core`, which the host does not
 * provide to plugins: importing it makes the bundled TUI fail to load with
 * "Cannot find package '@opentui/core'". `@opentui/solid` and `solid-js` are
 * host-provided, so the sidebar keeps using those. `BOLD` is
 * `1 << 0`.
 */
const BOLD = 1
/**
 * Rows the sidebar spends above the first resource row: the host's sidebar
 * title and footer, the sidebar's own padding, this plugin's header (title,
 * instance, project) and the border above the list. The body budget is the
 * terminal height minus this, so a short terminal collapses to the `show all`
 * affordances while a tall one lists everything the server sent.
 *
 * An estimate, not a measurement: the host's slot API publishes no height for
 * `sidebar.content`, so the terminal height is the closest available signal.
 */
export const SIDEBAR_CHROME_ROWS = 10
/** Even a one-line terminal keeps room for one row and its affordance. */
export const MIN_BODY_ROWS = 1
/**
 * Refresh cadence. Idle polling only exists to catch container drift that no
 * event announces; while a deployment is running the sidebar follows it closely.
 * The idle value is only a fallback — the server sends the configured cadence
 * in the `applications` payload.
 */
const REFRESH_SECONDS_IDLE = DEFAULT_REFRESH_SECONDS
const REFRESH_SECONDS_ACTIVE = 10
/** A restart is abandoned if it never reports a settled state. */
export const STARTING_TIMEOUT_MS = 3 * 60 * 1_000
/**
 * A just-triggered restart keeps spinning at least this long, so a poll that
 * still sees the old running state cannot clear it before Coolify reacts.
 */
export const STARTING_MIN_SPIN_MS = 15_000
/** Event-triggered reloads are trailing-debounced so a burst costs one request. */
const EVENT_DEBOUNCE_MS = 1_500
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
/** How many log lines the application log panel asks Coolify for. */
const LOG_LINES = 500
/** How often an open panel re-reads while it is visible. */
const LOG_POLL_MS = 4_000
const DEPLOYMENT_POLL_MS = 2_000

/**
 * A side chat's default rules: free to read, and every change still asks.
 */
const SIDE_CHAT_PERMISSIONS = [{ action: "coolify.read", resource: "*", effect: "allow" as const }]

/**
 * A debug session's rules: read Coolify, change nothing. A `deny` rule removes
 * the tool from the model's view entirely (see the README), so it cannot even
 * offer a write.
 */
export const READ_ONLY_PERMISSIONS = [
  { action: "coolify.read", resource: "*", effect: "allow" as const },
  { action: "coolify.write", resource: "*", effect: "deny" as const },
  { action: "coolify.deploy", resource: "*", effect: "deny" as const },
  { action: "coolify.destructive", resource: "*", effect: "deny" as const },
  { action: "coolify.secrets", resource: "*", effect: "deny" as const },
]

/** The runtime supports location-aware RPC calls, although the plugin SDK type narrows them. */
interface RpcLocationOptions {
  readonly location: { readonly directory: string }
}

type RpcMethod = (input: unknown, options?: RpcLocationOptions) => Promise<unknown>

function callRpc(method: unknown, input: unknown, directory: string | undefined): Promise<unknown> {
  return (method as RpcMethod)(input, directory ? { location: { directory } } : undefined)
}

export type LineTone = RuntimeTone | "muted"

/** What the mounted sidebar exposes back to the plugin. */
interface SidebarControls {
  readonly refresh: () => void
  /** Follow an application back up after the sidebar restarted it. */
  readonly markStarting: (applicationUUID: string) => void
  /** The same, for a database's start or restart. */
  readonly markStartingDatabase: (databaseUUID: string) => void
  /** Drives the sidebar's loading indicator during a show-all fetch. */
  readonly setBusy: (value: boolean) => void
}

/**
 * The last `applications` payload for one project directory.
 *
 * Held by the plugin rather than by a sidebar instance, so every session shares
 * it: a sidebar re-mounted by a session switch reuses the previous payload
 * instead of re-asking the server and resetting its countdown. Keyed by
 * directory, because that is what selects `coolify.json`, so a worktree keeps
 * its own entry and can never be shown its main checkout's state.
 */
export interface CachedApplications {
  readonly at: number
  readonly payload: ApplicationsPayload
}

/**
 * The cached payload for a directory and the seconds left before it lapses, or
 * `undefined` when there is none or it has aged past the payload's own cadence.
 */
export function readCachedApplications(
  cache: ReadonlyMap<string, CachedApplications>,
  key: string,
  now: number,
): { readonly entry: CachedApplications; readonly remainingSeconds: number } | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  const ttl = entry.payload.refreshSeconds ?? REFRESH_SECONDS_IDLE
  const elapsed = (now - entry.at) / 1_000
  if (elapsed >= ttl) return undefined
  return { entry, remainingSeconds: Math.max(1, Math.round(ttl - elapsed)) }
}

/**
 * The setup context, threaded into components instead of read with `usePlugin`.
 *
 * `usePlugin` looks the host's context up through Solid's `useContext`. The
 * published bundle resolves its own Solid, so that lookup crosses runtime
 * instances and throws "PluginContextProvider is missing". Passing the context
 * `setup` already received side-steps the lookup entirely — which is how the
 * other packaged TUI plugins do it.
 */
type PluginContext = ReturnType<typeof usePlugin>

export default Plugin.define({
  id: "opencode.coolify.tui",
  setup(context) {
    const rpc = context.client.rpc(CoolifyRpc)

    /**
     * The mounted sidebar publishes its controls here, so the Refresh action can
     * trigger one on demand and a lifecycle action can mark its application as
     * starting up. Events are broadcast the other way — a plugin can only emit
     * server-side, so the client cannot ask itself to re-read.
     */
    let sidebarControls: SidebarControls | undefined
    /**
     * The show-all dialogs get clicked repeatedly, and the project list changes
     * far less often than the mapped one, so a short cache avoids a round trip
     * per click. Applications and databases share it, so opening one dialog
     * after the other costs a single request.
     */
    let projectInventoryCache:
      | {
          at: number
          directory: string | undefined
          apps: readonly AppStatusPayload[]
          databases: readonly DatabaseStatusPayload[]
        }
      | undefined
    /**
     * The last mapped payload per project directory, shared by every session's
     * sidebar. A re-mounted sidebar reuses it until the cadence lapses, so it
     * neither re-asks the server nor resets its countdown. The directory is the
     * key because it decides which `coolify.json` applies, so a worktree has
     * its own entry.
     */
    const sidebarCache = new Map<string, CachedApplications>()
    /**
     * Directories whose model-driven linking has already been attempted.
     *
     * A side chat is fire-and-forget: the plugin cannot await its result, so
     * "the model failed" cannot be observed directly. A second click on the
     * same still-unlinked project is the signal, and it opens the paste box.
     */
    const modelLinkAttempts = new Set<string>()

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ message, variant })

    const currentSessionID = (): string | undefined => {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }

    /**
     * The current session's project directory.
     *
     * `context.location` is the *TUI's* launch directory, shared by every session
     * in it, so falling back to it silently shows one project's state for all of
     * them. The session's own location is used, then its project's canonical
     * directory, and only then the TUI's — which the side-chat path tolerates
     * because it only decides where a new session starts.
     */
    const directoryFor = (sessionID: string | undefined): string | undefined => {
      if (sessionID) {
        const session = context.data.session.get(sessionID)
        const fromSession = session?.location?.directory
        if (fromSession) return fromSession
        const projectID = session?.projectID
        if (projectID) {
          const canonical = context.data.project.get(projectID)?.canonical
          if (canonical) return canonical
        }
      }
      return context.location?.directory
    }

    const sessionDirectory = (): string | undefined => directoryFor(currentSessionID())

    async function currentCapabilities(): Promise<CapabilitiesPayload | undefined> {
      try {
        return (await callRpc(rpc.capabilities, {}, sessionDirectory())) as CapabilitiesPayload
      } catch (cause) {
        toast(`Could not read plugin state: ${message(cause)}`, "error")
        return undefined
      }
    }

    async function promptEndpoint(): Promise<boolean> {
      const endpoint = await context.ui.dialog.prompt({
        title: "Coolify instance URL",
        description: "Base URL of your self-hosted Coolify instance.",
        placeholder: "https://coolify.example.com",
      })
      if (!endpoint?.trim()) return false
      try {
        const saved = (await callRpc(rpc.setEndpoint, { endpoint: endpoint.trim() }, sessionDirectory())) as {
          ok?: boolean
          endpoint?: string
          message?: string
        }
        if (saved.ok !== true) {
          toast(saved.message ?? "That endpoint was rejected.", "error")
          return false
        }
        sidebarControls?.refresh()
        toast(`Using ${saved.endpoint}.`, "success")
        return true
      } catch (cause) {
        toast(`Could not save the endpoint: ${message(cause)}`, "error")
        return false
      }
    }

    async function promptToken(): Promise<boolean> {
      const token = await context.ui.dialog.prompt({
        title: "Coolify API token",
        description: "Create a token in Coolify under Keys & Tokens → API tokens.",
        placeholder: "1|abcdef...",
      })
      if (!token) return false
      try {
        await context.client.integration.connect.key({ integrationID: INTEGRATION_ID, key: token.trim() })
      } catch (cause) {
        toast(`Could not store the token: ${message(cause)}`, "error")
        return false
      }
      try {
        const result = (await callRpc(rpc.refreshCapabilities, {}, sessionDirectory())) as CapabilitiesPayload
        if (result.connected !== true) {
          toast(result.message ?? "Token stored, but the instance could not be reached.", "warning")
          return false
        }
        sidebarControls?.refresh()
        toast(`Connected to ${result.team?.name ?? result.endpoint ?? "Coolify"}.`, "success")
        return true
      } catch (cause) {
        toast(`Token stored, but probing failed: ${message(cause)}`, "warning")
        return false
      }
    }

    async function ensureConfigured(): Promise<boolean> {
      let state = await currentCapabilities()
      if (!state) return false
      if (state.endpointConfigured !== true) {
        if (!(await promptEndpoint())) return false
        state = await currentCapabilities()
        if (state?.endpointConfigured !== true) return false
      }
      if (state.connected === true) return true
      return promptToken()
    }

    /**
     * Run the deployment in a separate chat, in a background tab, so the current
     * conversation is never interrupted. The new session may read Coolify freely
     * but still asks before every write, deploy or delete.
     */
    /**
     * Open a side conversation in a background tab, or fall back to this chat
     * when tabs are disabled. Used for both deploy and "link with the model", so
     * neither needs a session to already be open.
     *
     * The instructions travel as a skill reference rather than a pasted prompt:
     * the runtime expands the registered skill into the message, so the same
     * skill serves a client that exposes skills but not plugin tools.
     */
    async function runInSideChat(
      title: string,
      text: string,
      options: {
        skill?: CoolifySkill
        permissions?: { action: string; resource: string; effect: "allow" | "deny" | "ask" }[]
      } = {},
    ): Promise<boolean> {
      // `promptInput`, not `message`: `message` is the error formatter below.
      const promptInput = { text, ...(options.skill ? { skills: [{ id: options.skill.id }] } : {}) }
      if (!context.ui.tabs.enabled()) {
        const runHere = await context.ui.dialog.confirm({
          title: "Tabs are disabled",
          message: "A side conversation needs session tabs. Run this in the current chat instead?",
          label: { confirm: "Run here", cancel: "Cancel" },
        })
        if (!runHere) return false
        const sessionID = currentSessionID()
        if (!sessionID) {
          toast("Open a session first.", "warning")
          return false
        }
        await context.client.session.prompt({ sessionID, ...promptInput })
        return true
      }

      const directory = sessionDirectory() ?? context.location?.directory ?? context.data.location.default().directory
      try {
        const created = await context.client.session.create({
          title,
          location: { directory },
          permissions: options.permissions ?? SIDE_CHAT_PERMISSIONS,
        })
        const sessionID = created?.id
        if (!sessionID) {
          toast("Could not create the side chat.", "error")
          return false
        }
        await context.client.session.prompt({ sessionID, ...promptInput })
        context.ui.tabs.open(sessionID)
        toast(`${title} started in a new tab.`, "success")
        return true
      } catch (cause) {
        toast(`Could not start the side chat: ${message(cause)}`, "error")
        return false
      }
    }

    async function deployInSideChat(app: AppStatusPayload | undefined): Promise<void> {
      const text = app
        ? `Target application: ${app.name} (${app.applicationUUID}).`
        : "Set up and deploy this project on Coolify."
      await runInSideChat(app ? `Deploy ${app.name}` : "Coolify deploy", text, { skill: DEPLOY_SKILL })
    }

    /**
     * A read-only session that looks into a failed deployment. The permissions
     * deny every mutating tier, so the model can investigate but not change
     * anything; the deployment UUID is passed explicitly because the session
     * starts in the project directory, not on the deployment screen.
     */
    async function debugDeployment(app: AppStatusPayload, deploymentUUID: string): Promise<void> {
      const text = [
        `Deployment ${deploymentUUID} of ${app.name} failed on Coolify.`,
        `Application UUID: ${app.applicationUUID}.`,
        "Find out why it failed using the coolify tools: read the deployment and its logs, the application's recent deployments, and its settings.",
        "You have read-only access — do not deploy, restart, change settings, or delete anything.",
        "Explain the failure and what would need to change.",
      ].join("\n")
      await runInSideChat(`Debug ${app.name}`, text, { permissions: READ_ONLY_PERMISSIONS })
    }

    /** The model-driven linking: needed for a monorepo, or when nothing matches. */
    async function linkWithModel(): Promise<boolean> {
      return await runInSideChat("Link repository", "Link this repository to its Coolify applications.", {
        skill: LINK_SKILL,
      })
    }

    /**
     * The `link` button beside an unlinked project: try the model first, then
     * fall back to asking the user to paste the config the model produced.
     */
    async function linkFirst(directory: string | undefined): Promise<void> {
      const key = directory ?? ""
      if (modelLinkAttempts.has(key)) {
        await promptForProjectJson(directory)
        return
      }
      if (!(await linkWithModel())) return
      modelLinkAttempts.add(key)
      toast("If the model could not link it, click link again to paste the config yourself.", "info")
    }

    /**
     * The manual fallback: paste a `coolify.json` and write it unchanged. A
     * textarea, because a config is multi-line and the prompt dialog is not.
     */
    async function promptForProjectJson(directory: string | undefined): Promise<void> {
      let draft: string | undefined
      await new Promise<void>((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }
        context.ui.dialog.set({ size: "large", centered: true })
        context.ui.dialog.show(
          () => (
            <ProjectJsonPopup
              context={context}
              onSubmit={(content) => {
                draft = content
                finish()
                context.ui.dialog.clear()
              }}
              onCancel={() => {
                finish()
                context.ui.dialog.clear()
              }}
            />
          ),
          // A click outside, or escape, closes without submitting.
          finish,
        )
      })
      if (draft === undefined || draft.trim() === "") return

      try {
        const result = (await callRpc(rpc.writeProjectJson, { directory, content: draft }, directory)) as {
          ok?: boolean
          file?: string
          message?: string
        }
        if (result.ok === true) {
          toast(`Linked this project in ${result.file}.`, "success")
          sidebarControls?.refresh()
        } else {
          toast(result.message ?? "Could not write coolify.json.", "error")
        }
      } catch (cause) {
        toast(`Could not write coolify.json: ${message(cause)}`, "error")
      }
    }

    /**
     * The deterministic linking: resolve the candidates for this directory, let
     * the user pick, and write `coolify.json` directly. No model turn, and no
     * session required.
     */
    /**
     * The single project-level entry point. The actions it lists used to be
     * standalone buttons; each still opens its own dedicated popup.
     */
    async function openConfigure(directory: string | undefined): Promise<void> {
      const choice = await context.ui.dialog.select<string>({
        title: "Coolify configuration",
        options: [
          { title: "Link this project", value: "link", description: "write coolify.json directly — no model" },
          { title: "Link with the model", value: "link-model", description: "background tab, for a monorepo" },
          { title: "Set up instance", value: "setup", description: "instance URL and API token" },
        ],
      })
      if (!choice) return
      if (choice === "link") return await linkFlow(directory)
      if (choice === "link-model") {
        await linkWithModel()
        return
      }
      openSetupPopup()
    }

    /**
     * Route `/coolify <aspect>` to the surface for that aspect.
     *
     * One command with arguments rather than a command per aspect: every one of
     * these already exists behind the Configure picker, and a picker you must
     * click through is the thing a command should skip. The two that write
     * settings are deliberately *not* gated on `ensureConfigured` — being
     * prompted for the endpoint while trying to set the endpoint is absurd.
     */
    async function runCoolifyCommand(input: string | undefined): Promise<void> {
      const aspect = parseCoolifyArgument(input)
      switch (aspect) {
        case "instance":
          await promptEndpoint()
          return
        case "token":
          await promptToken()
          return
        case "access":
          openSetupPopup()
          return
        case "link-model":
          await linkWithModel()
          return
        case "unknown":
          toast(`Unknown option. Try: ${COOLIFY_ASPECTS.join(", ")}.`, "warning")
          return
        case "hub":
          await openConfigure(sessionDirectory())
          return
        case "deploy":
        case "apps":
        case "link":
          // These need a working client, so they may prompt for one first.
          if (!(await ensureConfigured())) return
          if (aspect === "deploy") return await deployInSideChat(undefined)
          if (aspect === "apps") return await openAllApps(sessionDirectory())
          return await linkFlow(sessionDirectory())
      }
    }

    /**
     * A dedicated popup for the plugin's own configuration, separate from
     * anything application-related. It shows the current state and offers one
     * button per setting, re-opening itself after each change so the result is
     * visible immediately.
     */
    function openSetupPopup(): void {
      context.ui.dialog.set({ size: "medium", centered: true })
      context.ui.dialog.show(() => (
        <SetupPopup
          context={context}
          directory={sessionDirectory()}
          onSetEndpoint={async () => {
            await promptEndpoint()
            openSetupPopup()
          }}
          onSetToken={async () => {
            await promptToken()
            openSetupPopup()
          }}
        />
      ))
    }

    async function linkFlow(directory: string | undefined): Promise<void> {
      const state = await currentCapabilities()
      if (state?.connected !== true) {
        toast("Connect an API token first.", "warning")
        return
      }

      let resolution: ResolvePayload
      try {
        resolution = (await callRpc(rpc.resolve, { directory }, directory)) as ResolvePayload
      } catch (cause) {
        toast(`Could not search Coolify: ${message(cause)}`, "error")
        return
      }

      let chosen: CandidatePayload | undefined

      if (resolution.candidates.length === 0) {
        const typed = await context.ui.dialog.prompt({
          title: "Link this repository",
          description:
            resolution.notes.join(" ") || "No application matched. Paste an application UUID to link it.",
          placeholder: "application UUID",
        })
        if (!typed?.trim()) return
        chosen = { applicationUUID: typed.trim(), name: typed.trim() }
      } else if (resolution.candidates.length === 1) {
        const only = resolution.candidates[0]!
        const confirmed = await context.ui.dialog.confirm({
          title: "Link this repository",
          message: `Link this project to ${only.name} (${only.applicationUUID})?`,
          label: { confirm: "Link", cancel: "Cancel" },
        })
        if (!confirmed) return
        chosen = only
      } else {
        const value = await context.ui.dialog.select<string>({
          title: "Which application is this project?",
          current: resolution.best?.applicationUUID,
          options: resolution.candidates.map((entry) => ({
            title: entry.name,
            value: entry.applicationUUID,
            description: [entry.applicationUUID, entry.domains].filter(Boolean).join("  "),
            category: entry.reasons?.length ? entry.reasons.join(", ") : undefined,
          })),
        })
        if (!value) return
        chosen = resolution.candidates.find((entry) => entry.applicationUUID === value)
      }

      if (!chosen) return
      try {
        const result = (await callRpc(rpc.configureProject, {
          directory,
          ...(resolution.config?.projectUUID ? { projectUUID: resolution.config.projectUUID } : {}),
          ...(resolution.config?.environmentName ? { environmentName: resolution.config.environmentName } : {}),
          applications: { [slug(chosen.name) || "default"]: { applicationUUID: chosen.applicationUUID, name: chosen.name } },
        }, directory)) as { ok?: boolean; file?: string; message?: string }
        if (result.ok === true) toast(`Linked ${chosen.name} in ${result.file}.`, "success")
        else toast(result.message ?? "Could not link this project.", "error")
      } catch (cause) {
        toast(`Could not write coolify.json: ${message(cause)}`, "error")
      }
    }

    /** Application logs in a bounded, scrollable panel that starts at the tail. */
    async function showLogs(app: AppStatusPayload | undefined): Promise<void> {
      await openDialog(context, "xlarge", (close) => (
        <LogsPopup
          context={context}
          applicationUUID={app?.applicationUUID}
          applicationName={app?.name ?? "application"}
          onClose={close}
        />
      ))
    }

    /**
     * Deploy directly from the sidebar and watch Coolify build it. No model turn
     * is spent; the deployment's own log streams into the panel, and a failure
     * offers a read-only session to investigate it.
     */
    async function openDeployment(app: AppStatusPayload): Promise<void> {
      const confirmed = await context.ui.dialog.confirm({
        title: `Deploy ${app.name}`,
        message: `Build and deploy ${app.name} on Coolify now?`,
        label: { confirm: "Deploy", cancel: "Cancel" },
      })
      if (!confirmed) return
      sidebarControls?.markStarting(app.applicationUUID)
      await openDialog(context, "xlarge", (close) => (
        <DeploymentPopup
          context={context}
          applicationUUID={app.applicationUUID}
          applicationName={app.name}
          onRefresh={() => sidebarControls?.refresh()}
          onDebug={(deploymentUUID) => {
            close()
            void debugDeployment(app, deploymentUUID)
          }}
          onClose={close}
        />
      ))
    }

    /**
     * App-level actions only. Project-level concerns (linking, instance) live on
     * their own dedicated buttons, so this dialog never mixes the two.
     */
    async function openAppActions(app: AppStatusPayload): Promise<void> {
      const choice = await context.ui.dialog.select<string>({
        title: app.name,
        options: [
          { title: "Deploy", value: "deploy", description: "live build logs" },
          { title: "View logs", value: "logs" },
          { title: "Restart", value: "restart" },
          { title: "Roll back to a commit", value: "rollback" },
          { title: "Set up & deploy with the model", value: "model", description: "opens a background tab" },
        ],
      })
      if (!choice) return

      try {
        if (choice === "deploy") return await openDeployment(app)
        if (choice === "model") return await deployInSideChat(app)
        if (choice === "logs") return await showLogs(app)

        if (choice === "restart") {
          const confirmed = await context.ui.dialog.confirm({
            title: `Restart ${app.name}`,
            message: `Restart ${app.name} on Coolify?`,
            label: { confirm: "Restart", cancel: "Cancel" },
          })
          if (!confirmed) return
          const result = (await rpc.deploy({ action: "restart", applicationUUID: app.applicationUUID, wait: false })) as {
            message?: string
          }
          sidebarControls?.markStarting(app.applicationUUID)
          toast(result.message ?? "Restart requested.", "success")
          return
        }

        const commit = await context.ui.dialog.prompt({
          title: `Roll back ${app.name}`,
          description: "Commit to redeploy. The model can list candidates with coolify_application action rollback_images.",
          placeholder: "commit sha",
        })
        if (!commit?.trim()) return
        const result = (await rpc.deploy({
          action: "rollback",
          applicationUUID: app.applicationUUID,
          commit: commit.trim(),
        })) as { message?: string }
        sidebarControls?.markStarting(app.applicationUUID)
        toast(result.message ?? "Rollback requested.", "success")
      } catch (cause) {
        toast(`Coolify: ${message(cause)}`, "error")
      }
    }

    /**
     * Database lifecycle. Databases have no logs or rollback in the API, so the
     * only actions are start, stop and restart — all through the same `deploy`
     * RPC, which routes a `databaseUUID` to the database endpoints.
     */
    async function openDatabaseActions(database: DatabaseStatusPayload): Promise<void> {
      const choice = await context.ui.dialog.select<string>({
        title: database.name,
        options: [
          { title: "Restart", value: "restart" },
          { title: "Start", value: "start" },
          { title: "Stop", value: "stop" },
        ],
      })
      if (!choice) return
      if (!database.databaseUUID) {
        toast(`Coolify never resolved a UUID for ${database.name}, so it cannot be controlled from here.`, "warning")
        return
      }

      const verb = choice === "restart" ? "Restart" : choice === "start" ? "Start" : "Stop"
      const confirmed = await context.ui.dialog.confirm({
        title: `${verb} ${database.name}`,
        message: `${verb} ${database.name} on Coolify?`,
        label: { confirm: verb, cancel: "Cancel" },
      })
      if (!confirmed) return

      try {
        const result = (await rpc.deploy({
          action: choice,
          databaseUUID: database.databaseUUID,
          wait: false,
        })) as { message?: string }
        // Start and restart come back up; a stop is deliberately not followed,
        // so no spinner claims it is returning.
        if (choice !== "stop") sidebarControls?.markStartingDatabase(database.databaseUUID)
        sidebarControls?.refresh()
        toast(result.message ?? `${verb} requested.`, "success")
      } catch (cause) {
        toast(`Coolify: ${message(cause)}`, "error")
      }
    }

    /**
     * The project's full application and database inventory, read through the
     * `project` scope and cached briefly for the show-all dialogs.
     */
    async function projectInventory(
      directory: string | undefined,
      label: string,
    ): Promise<{ apps: readonly AppStatusPayload[]; databases: readonly DatabaseStatusPayload[] } | undefined> {
      const INVENTORY_TTL_MS = 10_000
      const cached =
        projectInventoryCache &&
        projectInventoryCache.directory === directory &&
        Date.now() - projectInventoryCache.at < INVENTORY_TTL_MS
      if (cached) return projectInventoryCache

      sidebarControls?.setBusy(true)
      try {
        const data = (await callRpc(rpc.applications, { scope: "project", directory }, directory)) as ApplicationsPayload
        projectInventoryCache = {
          at: Date.now(),
          directory,
          apps: data.apps ?? [],
          databases: data.databases ?? [],
        }
        return projectInventoryCache
      } catch (cause) {
        toast(`Could not list ${label}: ${message(cause)}`, "error")
        return undefined
      } finally {
        sidebarControls?.setBusy(false)
      }
    }

    /**
     * Every application in the project, for when the sidebar list is truncated
     * or an app is not linked to this repository yet.
     */
    async function openAllApps(directory: string | undefined): Promise<void> {
      const inventory = await projectInventory(directory, "applications")
      if (!inventory) return
      const { apps } = inventory
      if (apps.length === 0) {
        toast("No applications in this project.", "warning")
        return
      }
      const chosen = await context.ui.dialog.select<string>({
        title: "Applications in this project",
        options: apps.map((app) => ({
          title: app.name,
          value: app.applicationUUID,
          description: [app.runtime?.label, app.path].filter(Boolean).join("  "),
        })),
      })
      if (!chosen) return
      const app = apps.find((entry) => entry.applicationUUID === chosen)
      if (app) await openAppActions(app)
    }

    /**
     * Every database in the project, for when the sidebar list is truncated or
     * a database was created in the Coolify UI rather than the config.
     */
    async function openAllDatabases(directory: string | undefined): Promise<void> {
      const inventory = await projectInventory(directory, "databases")
      if (!inventory) return
      const { databases } = inventory
      if (databases.length === 0) {
        toast("No databases in this project.", "warning")
        return
      }
      const chosen = await context.ui.dialog.select<string>({
        title: "Databases in this project",
        options: databases.map((database) => ({
          title: database.name,
          value: database.databaseUUID ?? database.key,
          description: [database.type, database.environment, database.path].filter(Boolean).join("  "),
        })),
      })
      if (!chosen) return
      const database = databases.find((entry) => (entry.databaseUUID ?? entry.key) === chosen)
      if (database) await openDatabaseActions(database)
    }

    // --- Commands -----------------------------------------------------------
    //
    // `keymap.layer` needs the TUI's Keymap provider, which does not exist
    // during `setup`. Registering it there throws "Keymap.Provider is missing"
    // and aborts the whole plugin, so the layer comes from an `app` slot render.
    const commandsLayer = (): KeymapLayer => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "coolify.panel.open",
          title: "Coolify: configure or inspect",
          description: `No argument opens the picker. Or name an aspect: ${COOLIFY_ASPECTS.join(", ")}.`,
          group: "Coolify",
          bind: false,
          palette: true,
          slash: { name: "coolify", arguments: true },
          run: async (input) => {
            await runCoolifyCommand(input)
          },
        },
      ],
      bindings: ["coolify.panel.open"],
    })

    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(commandsLayer)
        return null
      },
    })

    context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <CoolifySidebar
          context={context}
          sessionID={input.sessionID}
          cache={sidebarCache}
          onAppActions={openAppActions}
          onDatabaseActions={openDatabaseActions}
          onAllApps={() => openAllApps(sessionDirectory())}
          onAllDatabases={() => openAllDatabases(sessionDirectory())}
          onConfigure={() => void openConfigure(sessionDirectory())}
          onLinkFirst={() => linkFirst(sessionDirectory())}
          onReady={(controls) => {
            sidebarControls = controls
          }}
        />
      ),
    })
  },
})

/**
 * A compact sidebar section.
 *
 * The name and the state are separate elements so truncation can never eat the
 * separator: the name flexes and ellipsises, the state stays put at the right.
 * Project-level actions are their own labelled buttons rather than being mixed
 * into the per-application dialog.
 */
function CoolifySidebar(props: {
  context: PluginContext
  sessionID: string
  /** Shared across sessions, so a re-mounted sidebar finds the last payload. */
  cache: Map<string, CachedApplications>
  onAppActions: (app: AppStatusPayload) => Promise<void>
  onDatabaseActions: (database: DatabaseStatusPayload) => Promise<void>
  onAllApps: () => Promise<void>
  onAllDatabases: () => Promise<void>
  onConfigure: () => void
  onLinkFirst: () => Promise<void>
  onReady: (controls: SidebarControls) => void
}) {
  const context = props.context
  const rpc = context.client.rpc(CoolifyRpc)
  const theme = () => context.theme.text
  const surface = () => context.theme.background

  const [data, setData] = createSignal<ApplicationsPayload | undefined>()
  const [failed, setFailed] = createSignal(false)
  const [hover, setHover] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [noDirectory, setNoDirectory] = createSignal(false)
  const [remaining, setRemaining] = createSignal(REFRESH_SECONDS_IDLE)
  const [frame, setFrame] = createSignal(0)
  const [starting, setStarting] = createSignal<readonly StartingUp[]>([])
  const [startingDatabases, setStartingDatabases] = createSignal<readonly StartingUp[]>([])
  let inFlight: Promise<void> | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  /** The rows from the previous poll, used to spot a restart we did not trigger. */
  let previousRows: readonly AppStatusPayload[] = []
  let previousDatabaseRows: readonly DatabaseStatusPayload[] = []

  const idleSeconds = (): number => data()?.refreshSeconds ?? REFRESH_SECONDS_IDLE
  const isStarting = (app: AppStatusPayload): boolean =>
    starting().some((entry) => entry.id === app.applicationUUID)
  const isDatabaseStarting = (database: DatabaseStatusPayload): boolean =>
    startingDatabases().some((entry) => entry.id === database.databaseUUID)

  // The terminal height is reactive, so a resize re-plans how many rows fit.
  // Applications and databases draw from the same budget, in render order.
  const dimensions = useTerminalDimensions()
  const budget = createMemo(() => sidebarRowBudget(dimensions().height))
  const planned = createMemo(() => planSidebarRows(applicationGroups(data()), budget()))
  const configureVisible = createMemo(() => shouldShowConfigure(data()))

  /**
   * Resolved the same way as the server-side helper. There is deliberately no
   * fallback to the TUI's own directory: showing a different project's state is
   * worse than showing that this session's project could not be determined.
   */
  const directory = (): string | undefined => {
    const session = context.data.session.get(props.sessionID)
    const fromSession = session?.location?.directory
    if (fromSession) return fromSession
    const projectID = session?.projectID
    if (projectID) {
      const canonical = context.data.project.get(projectID)?.canonical
      if (canonical) return canonical
    }
    return undefined
  }

  /**
   * Fold a payload into the sidebar's signals and report the cadence it asks
   * for. Shared by a fresh fetch and a cache hit, so both reconcile the restart
   * trackers and land the same way.
   */
  const applyPayload = (payload: ApplicationsPayload): number => {
    const nextRows = payload.apps ?? []
    const nextDatabaseRows = payload.databases ?? []
    const now = Date.now()
    const cadence = payload.refreshSeconds ?? REFRESH_SECONDS_IDLE
    const nextStarting = reconcileStartingUp(starting(), previousRows, nextRows, now, STARTING_TIMEOUT_MS)
    const nextStartingDatabases = reconcileStartingDatabases(
      startingDatabases(),
      previousDatabaseRows,
      nextDatabaseRows,
      now,
      STARTING_TIMEOUT_MS,
    )
    previousRows = nextRows
    previousDatabaseRows = nextDatabaseRows
    setStarting(nextStarting)
    setStartingDatabases(nextStartingDatabases)
    setData(payload)
    setFailed(false)
    return refreshSeconds(nextRows, cadence, nextStarting, nextStartingDatabases)
  }

  /**
   * Whether a deployment or restart is in flight, in which case even a timed
   * poll asks for fresh data: the point of the active cadence is to watch the
   * container come back, which a cached payload would hide.
   */
  const isPollingActive = (): boolean =>
    starting().length > 0 ||
    startingDatabases().length > 0 ||
    (data()?.apps ?? []).some(isStartingSignal) ||
    (data()?.databases ?? []).some(isDatabaseStartingSignal)

  /**
   * Coalesced: concurrent callers share one request. During a deployment the
   * server emits progress every few seconds, and without this each event would
   * start its own round trip.
   *
   * A re-mounted sidebar checks the plugin-wide cache first, so a session switch
   * within the cadence neither re-asks the server nor resets the countdown.
   * `fresh` skips that cache; the event listeners and the manual refresh pass it
   * because their whole purpose is to observe something the cache would hide.
   */
  const load = (fresh = false): Promise<void> => {
    const base = directory()
    setNoDirectory(base === undefined)
    const key = base ?? ""

    if (!fresh && !isPollingActive()) {
      const hit = readCachedApplications(props.cache, key, Date.now())
      if (hit) {
        const cadence = applyPayload(hit.entry.payload)
        // The payload may have been captured mid-deploy, so the active cadence
        // can be sooner than the entry's remaining life.
        setRemaining(Math.min(hit.remainingSeconds, cadence))
        return Promise.resolve()
      }
    }

    if (inFlight) return inFlight
    setBusy(true)
    let cadence = idleSeconds()
    inFlight = (async () => {
      try {
        // The RPC `location` option is not honoured, so the directory travels in
        // the input instead. Without it the server answers for its own default
        // location and a freshly mapped project shows nothing.
        const payload = (await callRpc(rpc.applications, {
          scope: "mapped",
          ...(base === undefined ? {} : { directory: base }),
          ...(fresh ? { fresh: true } : {}),
        }, base)) as ApplicationsPayload
        cadence = applyPayload(payload)
        props.cache.set(key, { at: Date.now(), payload })
      } catch {
        setFailed(true)
      } finally {
        setBusy(false)
        setRemaining(cadence)
        inFlight = undefined
      }
    })()
    return inFlight
  }

  /**
   * Trailing debounce for event-driven reloads. A deployment emits progress
   * every few seconds; reloading per event cost thousands of requests per
   * deploy, and the coalescing above only stopped the overlap, not the volume.
   */
  const scheduleLoad = (delayMs = EVENT_DEBOUNCE_MS): void => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      void load(true)
    }, delayMs)
  }

  onMount(() => {
    void load()
    props.onReady({
      refresh: () => void load(true),
      markStarting: (applicationUUID) =>
        setStarting((existing) => markStartingUp(existing, applicationUUID, Date.now())),
      markStartingDatabase: (databaseUUID) =>
        setStartingDatabases((existing) => markStartingUp(existing, databaseUUID, Date.now())),
      setBusy,
    })
    // Every listener debounces. `project.changed` matters most: without it a
    // mapping written by the model would not appear until the next tick.
    const stops = [
      rpc.events.on("deploy.progress", () => scheduleLoad()),
      rpc.events.on("link.changed", () => scheduleLoad()),
      rpc.events.on("capabilities.changed", () => scheduleLoad()),
      rpc.events.on("project.changed", () => scheduleLoad()),
    ]
    // One heartbeat drives both the visible countdown and the auto refresh.
    const heartbeat = setInterval(() => setRemaining((seconds) => seconds - 1), 1_000)
    onCleanup(() => {
      for (const stop of stops) stop()
      clearInterval(heartbeat)
      if (debounce) clearTimeout(debounce)
    })
  })

  createEffect(() => {
    if (remaining() > 0) return
    setRemaining(idleSeconds())
    void load()
  })

  // Spinner frames run while a request is in flight or a row is coming back up.
  createEffect(() => {
    if (!busy() && starting().length === 0 && startingDatabases().length === 0) return
    const id = setInterval(() => setFrame((value) => value + 1), 100)
    onCleanup(() => clearInterval(id))
  })

  return (
    <box flexDirection="column">
      {/* Title: instance, then the working directory it is answering for. The
          directory is on screen because a wrong project is otherwise invisible,
          which is exactly how a shared-state bug hides. */}
      <box flexDirection="row" gap={1} onMouseUp={() => void load(true)}>
        <text attributes={BOLD} fg={theme().base} flexShrink={0}>
          Coolify
        </text>
        <Show when={busy()}>
          <text fg={theme().feedback.info?.base ?? theme().base} flexShrink={0}>
            {SPINNER[frame() % SPINNER.length]}
          </text>
        </Show>
        <box flexGrow={1} />
        <text fg={theme().muted} wrapMode="none" flexShrink={0}>
          {remaining()}s
        </text>
      </box>

      {/* The instance and the project each get their own full-width line, so
          neither is cut off with an ellipsis. The project wraps on characters,
          because a path has no spaces to break on. */}
      <text fg={failed() ? theme().feedback.error.base : theme().muted} wrapMode="word">
        {failed() ? "unreachable" : (data()?.capabilities?.team?.name ?? instanceHint(data()))}
      </text>
      <text
        fg={noDirectory() ? theme().feedback.warning.base : theme().muted}
        wrapMode="none"
        onMouseUp={() =>
          context.ui.toast.show({
            message: noDirectory() ? "No project directory for this session." : `Project: ${directory()}`,
            variant: "info",
          })
        }
      >
        {noDirectory() ? "no project directory" : abbreviatePath(directory() ?? "project unknown")}
      </text>

      {/* Applications, then databases: status light, name, state. One section
          per config. */}
      <box border={["top"]} borderColor={theme().muted} flexDirection="column">
        <For each={planned()}>
          {(group, groupIndex) => (
            <box flexDirection="column">
              <Show when={group.heading}>
                <text fg={theme().muted} wrapMode="none" truncate>
                  {group.heading}
                </text>
              </Show>

              <For each={group.environments}>
                {(environment, envIndex) => (
                  <box flexDirection="column">
                    {/* A repository often maps the same application once per
                        environment, and a project can define several even when
                        only one has apps, so the label follows the project's
                        inventory rather than the number of populated groups. */}
                    <Show when={group.showEnvironments}>
                      <text fg={theme().muted} wrapMode="none" truncate>
                        {environment.environment ?? "no environment"}
                      </text>
                    </Show>

                    <For each={environment.apps}>
                      {(app, index) => {
                        // Each section owns its rows, so hover is keyed per group.
                        const key = `${groupIndex()}:${envIndex()}:${index()}`
                        return (
                          <box
                            flexDirection="row"
                            gap={1}
                            backgroundColor={hover() === key ? surface().raised?.high : undefined}
                            onMouseOver={() => setHover(key)}
                            onMouseOut={() => setHover(null)}
                            onMouseUp={() => void props.onAppActions(app)}
                          >
                            <Show
                              when={isStarting(app)}
                              fallback={<text fg={toneColour(theme(), appRowTone(app))}>{statusLight(appRowTone(app))}</text>}
                            >
                              <text fg={theme().feedback.info?.base ?? theme().base}>
                                {SPINNER[frame() % SPINNER.length]}
                              </text>
                            </Show>
                            <text fg={theme().base} wrapMode="none" truncate flexGrow={1} minWidth={0}>
                              {app.name}
                            </text>
                            <text fg={theme().muted} wrapMode="none" flexShrink={0}>
                              {appRowState(app)}
                            </text>
                          </box>
                        )
                      }}
                    </For>
                  </box>
                )}
              </For>

              <Show when={group.hiddenApps > 0}>
                <box flexDirection="row" gap={1} onMouseUp={() => void props.onAllApps()}>
                  <Show when={busy()}>
                    <text fg={theme().feedback.info?.base ?? theme().base}>{SPINNER[frame() % SPINNER.length]}</text>
                  </Show>
                  <text fg={theme().muted} wrapMode="none" truncate>
                    {busy() ? "loading…" : `+${group.hiddenApps} more · show all`}
                  </text>
                </box>
              </Show>

              <Show when={!failed() && data()?.connected && group.appCount === 0}>
                <box flexDirection="row" gap={1}>
                  <text fg={theme().muted} wrapMode="none" truncate flexShrink={1} minWidth={0}>
                    {group.configFile ? "not deployed" : "not deployed · no coolify.json"}
                  </text>
                  {/* The one action that makes sense for an unlinked project,
                      and the only place the sidebar offers one inline. */}
                  <text
                    fg={theme().feedback.info?.base ?? theme().base}
                    wrapMode="none"
                    flexShrink={0}
                    onMouseUp={() => void props.onLinkFirst()}
                  >
                    link
                  </text>
                </box>
              </Show>

              {/* Databases live in their own section below the applications.
                  They are attributed through the project's environment ids,
                  since the API does not report a database's project directly. */}
              <Show when={group.databaseCount > 0}>
                <box flexDirection="column">
                  <text fg={theme().muted} wrapMode="none" truncate>
                    databases
                  </text>
                  <For each={group.databases}>
                    {(database, index) => {
                      const key = `db:${groupIndex()}:${index()}`
                      return (
                        <box
                          flexDirection="row"
                          gap={1}
                          backgroundColor={hover() === key ? surface().raised?.high : undefined}
                          onMouseOver={() => setHover(key)}
                          onMouseOut={() => setHover(null)}
                          onMouseUp={() => void props.onDatabaseActions(database)}
                        >
                          <Show
                            when={isDatabaseStarting(database)}
                            fallback={
                              <text fg={toneColour(theme(), databaseRowTone(database))}>
                                {statusLight(databaseRowTone(database))}
                              </text>
                            }
                          >
                            <text fg={theme().feedback.info?.base ?? theme().base}>
                              {SPINNER[frame() % SPINNER.length]}
                            </text>
                          </Show>
                          {/* Name and environment travel together on the left;
                              the environment is muted grey so the name keeps the
                              primary colour. A grow wrapper, rather than the
                              name alone, keeps the environment hugging the name
                              instead of being pushed against the state. */}
                          <box flexDirection="row" gap={1} flexGrow={1} minWidth={0}>
                            <text fg={theme().base} wrapMode="none" truncate minWidth={0}>
                              {database.name}
                            </text>
                            <Show when={database.environment}>
                              <text fg={theme().muted} wrapMode="none" flexShrink={0}>
                                {`· ${database.environment}`}
                              </text>
                            </Show>
                          </box>
                          <text fg={theme().muted} wrapMode="none" flexShrink={0}>
                            {databaseRowState(database)}
                          </text>
                        </box>
                      )
                    }}
                  </For>
                  <Show when={group.hiddenDatabases > 0}>
                    <box flexDirection="row" gap={1} onMouseUp={() => void props.onAllDatabases()}>
                      <Show when={busy()}>
                        <text fg={theme().feedback.info?.base ?? theme().base}>{SPINNER[frame() % SPINNER.length]}</text>
                      </Show>
                      <text fg={theme().muted} wrapMode="none" truncate>
                        {busy() ? "loading…" : `+${group.hiddenDatabases} more · show all`}
                      </text>
                    </box>
                  </Show>
                </box>
              </Show>
            </box>
          )}
        </For>
      </box>

      {/* One entry point, and only while it has something to offer. */}
      <Show when={configureVisible()}>
        <box border={["top"]} borderColor={theme().muted} onMouseUp={props.onConfigure}>
          <text fg={theme().feedback.info?.base ?? theme().base} wrapMode="none" truncate>
            Configure
          </text>
        </box>
      </Show>
    </box>
  )
}

/**
 * Show a custom dialog and resolve when it closes. `render` receives a `close`
 * callback for the component's own buttons; the host also calls `onClose` for
 * escape and outside clicks, so both paths settle the same promise.
 */
function openDialog(
  context: PluginContext,
  size: "medium" | "large" | "xlarge",
  render: (close: () => void) => JSX.Element,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const close = () => {
      context.ui.dialog.clear()
      finish()
    }
    context.ui.dialog.set({ size, centered: true })
    context.ui.dialog.show(() => render(close), finish)
  })
}

/**
 * A bounded, self-scrolling log viewport.
 *
 * `stickyScroll` with `stickyStart="bottom"` keeps the newest lines in view as
 * output arrives, and only stops following once the reader scrolls up. The
 * viewport is a `scrollbox`, not a `text`, so a long build cannot push the
 * dialog past the edge of the terminal.
 */
function LogView(props: { context: PluginContext; text: string }) {
  const theme = () => props.context.theme.text
  return (
    <scrollbox
      flexGrow={1}
      minHeight={6}
      focused
      stickyScroll
      stickyStart="bottom"
      border={["top"]}
      borderColor={theme().muted}
    >
      <text fg={theme().base} wrapMode="word">
        {props.text}
      </text>
    </scrollbox>
  )
}

/**
 * Application logs, refreshed while open. The panel asks for the tail and the
 * scrollbox starts at the bottom, so it opens on the latest output rather than
 * the oldest.
 */
function LogsPopup(props: {
  context: PluginContext
  applicationUUID?: string
  applicationName: string
  onClose: () => void
}) {
  const context = props.context
  const rpc = context.client.rpc(CoolifyRpc)
  const theme = () => context.theme.text
  const action = () => theme().feedback.info?.base ?? theme().base
  const [body, setBody] = createSignal("Loading logs…")
  const [busy, setBusy] = createSignal(false)

  const load = async () => {
    setBusy(true)
    try {
      const result = (await rpc.logs({ applicationUUID: props.applicationUUID, lines: LOG_LINES })) as {
        logs?: string
        message?: string
      }
      const logs = result.logs?.trim()
      setBody(logs && logs !== "" ? logs : (result.message ?? "No logs."))
    } catch (cause) {
      setBody(`Could not read logs: ${message(cause)}`)
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    void load()
    const timer = setInterval(() => void load(), LOG_POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <box flexDirection="column" gap={1} padding={1} height="100%">
      <text attributes={BOLD} fg={theme().base} wrapMode="none" truncate>
        {`Logs · ${props.applicationName}`}
      </text>
      <LogView context={context} text={body()} />
      <box flexDirection="row" gap={2}>
        <text fg={action()} wrapMode="none" onMouseUp={() => void load()}>
          {busy() ? "refreshing…" : "refresh"}
        </text>
        <text fg={theme().muted} wrapMode="none" onMouseUp={props.onClose}>
          close
        </text>
      </box>
    </box>
  )
}

/**
 * A deployment started from the sidebar, with Coolify's own build log streamed
 * in as it runs. The log is polled rather than waited on, so the panel stays
 * responsive and the deployment UUID can be handed to a debug session if the
 * build fails.
 */
function DeploymentPopup(props: {
  context: PluginContext
  applicationUUID: string
  applicationName: string
  onRefresh: () => void
  onDebug: (deploymentUUID: string) => void
  onClose: () => void
}) {
  const context = props.context
  const rpc = context.client.rpc(CoolifyRpc)
  const theme = () => context.theme.text
  const action = () => theme().feedback.info?.base ?? theme().base
  const [deploymentUUID, setDeploymentUUID] = createSignal<string | undefined>()
  const [status, setStatus] = createSignal("queued")
  const [logs, setLogs] = createSignal("")
  const [note, setNote] = createSignal<string | undefined>()
  const [terminal, setTerminal] = createSignal(false)
  const [frame, setFrame] = createSignal(0)

  const tone = (): LineTone => {
    if (status() === "failed") return "bad"
    if (status() === "cancelled") return "muted"
    if (status() === "finished") return "ok"
    if (status() === "queued" || status() === "in_progress") return "warn"
    return "unknown"
  }
  const statusWord = (): string => {
    if (status() === "in_progress") return "building"
    if (status() === "queued") return "queued"
    if (status() === "finished") return "finished"
    if (status() === "cancelled") return "cancelled"
    return status()
  }
  const running = (): boolean => !terminal()
  const body = (): string =>
    logs().trim() === "" ? (note() ?? "Waiting for the build to produce output…") : logs()

  const cancel = async (): Promise<void> => {
    const uuid = deploymentUUID()
    if (!uuid) return
    await rpc.cancelDeployment({ deploymentUUID: uuid }).catch(() => undefined)
    setNote("Cancellation requested.")
  }

  onMount(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const spin = setInterval(() => setFrame((value) => value + 1), 100)
    const sleep = (ms: number) => new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    })

    const poll = async (uuid: string): Promise<void> => {
      while (!cancelled) {
        const data = (await rpc.deployment({ deploymentUUID: uuid }).catch(() => undefined)) as
          | DeploymentLogPayload
          | undefined
        if (cancelled) return
        if (data) {
          setStatus(normalizeDeploymentStatus(data.status))
          if (typeof data.logs === "string") setLogs(data.logs)
          if (data.message) setNote(data.message)
          if (data.terminal === true) {
            setTerminal(true)
            props.onRefresh()
            return
          }
        }
        await sleep(DEPLOYMENT_POLL_MS)
      }
    }

    const kick = async (): Promise<void> => {
      try {
        const result = (await rpc.deploy({
          action: "deploy",
          applicationUUID: props.applicationUUID,
          wait: false,
        })) as { tickets?: readonly { deploymentUUID?: string }[]; message?: string }
        if (cancelled) return
        const uuid = result.tickets?.[0]?.deploymentUUID
        if (!uuid) {
          setStatus("failed")
          setTerminal(true)
          setNote(result.message ?? "Coolify accepted the request but returned no deployment.")
          return
        }
        setDeploymentUUID(uuid)
        props.onRefresh()
        await poll(uuid)
      } catch (cause) {
        if (cancelled) return
        setStatus("failed")
        setTerminal(true)
        setNote(message(cause))
      }
    }

    void kick()
    onCleanup(() => {
      cancelled = true
      clearInterval(spin)
      if (timer) clearTimeout(timer)
    })
  })

  return (
    <box flexDirection="column" gap={1} padding={1} height="100%">
      <box flexDirection="row" gap={1}>
        <Show
          when={status() === "queued" || status() === "in_progress"}
          fallback={<text fg={toneColour(theme(), tone())}>{statusLight(tone())}</text>}
        >
          <text fg={theme().feedback.info?.base ?? theme().base}>{SPINNER[frame() % SPINNER.length]}</text>
        </Show>
        <text attributes={BOLD} fg={theme().base} wrapMode="none" truncate>
          {`Deploy · ${props.applicationName} · ${statusWord()}`}
        </text>
      </box>

      <Show when={status() === "failed"}>
        <text fg={toneColour(theme(), "bad")} wrapMode="word">
          The deployment failed. Start a read-only session to find out why.
        </text>
      </Show>

      <LogView context={context} text={body()} />

      <box flexDirection="row" gap={2}>
        <Show when={status() === "failed"}>
          <text
            fg={action()}
            wrapMode="none"
            onMouseUp={() => {
              const uuid = deploymentUUID()
              if (uuid) props.onDebug(uuid)
            }}
          >
            debug in a read-only session
          </text>
        </Show>
        <Show when={running()}>
          <text fg={theme().muted} wrapMode="none" onMouseUp={() => void cancel()}>
            cancel
          </text>
        </Show>
        <text fg={theme().muted} wrapMode="none" onMouseUp={props.onClose}>
          close
        </text>
      </box>
    </box>
  )
}

/**
 * A paste box for a `coolify.json`.
 *
 * The dialog API's prompt is single-line and a config is not, so this is a
 * custom dialog around a textarea. `ctrl+s` submits; `return` inserts a newline,
 * which is what a multi-line paste needs.
 */
function ProjectJsonPopup(props: {
  context: PluginContext
  onSubmit: (content: string) => void
  onCancel: () => void
}) {
  const context = props.context
  const theme = () => context.theme.text
  const action = () => theme().feedback.info?.base ?? theme().base
  // Structurally typed: only `plainText` is needed, so the renderable class
  // does not have to be imported here.
  let field: { readonly plainText: string } | undefined
  const submit = () => props.onSubmit(field?.plainText ?? "")

  return (
    <box flexDirection="column" gap={1} padding={1}>
      <text attributes={BOLD} fg={theme().base}>
        Paste coolify.json
      </text>
      <text fg={theme().muted} wrapMode="none" truncate>
        Paste the config the model produced, then ctrl+s to write it.
      </text>
      <textarea
        ref={(value) => {
          field = value
        }}
        focused
        height={10}
        placeholder={'{ "applications": { "web": { "applicationUUID": "…" } } }'}
        keyBindings={[{ name: "s", ctrl: true, action: "submit" }]}
        onSubmit={submit}
      />
      <box flexDirection="row" gap={2}>
        <text fg={action()} wrapMode="none" onMouseUp={submit}>
          write it
        </text>
        <text fg={theme().muted} wrapMode="none" onMouseUp={() => props.onCancel()}>
          cancel
        </text>
      </box>
    </box>
  )
}

/**
 * The plugin's own configuration, in one dedicated popup: what the instance is,
 * whether the token works, and one button per setting.
 */
function SetupPopup(props: {
  context: PluginContext
  directory?: string
  onSetEndpoint: () => Promise<void>
  onSetToken: () => Promise<void>
}) {
  const context = props.context
  const rpc = context.client.rpc(CoolifyRpc)
  const theme = () => context.theme.text
  const action = () => theme().feedback.info?.base ?? theme().base

  const [data, setData] = createSignal<CapabilitiesPayload | undefined>()
  const [refreshing, setRefreshing] = createSignal(false)

  /**
   * Re-probe rather than re-read: the report is cached for ten minutes, and
   * "show me what this token can do" is exactly when the cached answer is the
   * one thing you do not want.
   */
  const refreshAccess = async () => {
    if (refreshing()) return
    setRefreshing(true)
    try {
      setData((await callRpc(rpc.refreshCapabilities, {}, props.directory)) as CapabilitiesPayload)
      context.ui.toast.show({ message: "Access re-checked.", variant: "success" })
    } catch (cause) {
      context.ui.toast.show({ message: `Could not re-check access: ${message(cause)}`, variant: "error" })
    } finally {
      setRefreshing(false)
    }
  }

  /**
   * Five steps from no access to full access. Reds and greens come from the
   * theme so they match every theme; the orange and lime between them are
   * fixed, because the theme only names three feedback levels.
   */
  const accessColour = (): string =>
    [
      theme().feedback.error.base,
      "#fb923c",
      theme().feedback.warning.base,
      "#a3e635",
      theme().feedback.success.base,
    ][accessLevel(data())] ?? theme().muted

  const load = async () => {
    try {
      setData((await callRpc(rpc.capabilities, {}, props.directory)) as CapabilitiesPayload)
    } catch {
      setData(undefined)
    }
  }

  onMount(() => void load())

  const close = () => context.ui.dialog.clear()

  return (
    <box flexDirection="column" gap={1} padding={1}>
      <text attributes={BOLD} fg={theme().base}>
        Coolify instance
      </text>

      <box flexDirection="column">
        <text fg={theme().muted} wrapMode="none" truncate>
          endpoint  {data()?.endpoint ?? "not set"}
        </text>
        <text
          fg={data()?.connected ? theme().feedback.success.base : theme().feedback.warning.base}
          wrapMode="none"
          truncate
        >
          token     {data()?.connected ? "connected" : (data()?.message ?? "not connected")}
        </text>
        {/* The access detail lives here now, not in the sidebar: it describes
            the instance, which is what this popup is about. */}
        <Show when={data()?.connected}>
          <box flexDirection="row">
            <text fg={accessColour()} wrapMode="none" flexShrink={0}>
              access
            </text>
            <text fg={theme().muted} wrapMode="none" flexShrink={0}>
              ·
            </text>
            <Show
              when={abilityEntries(data()).some((entry) => entry.status !== "unknown")}
              fallback={
                <text fg={accessColour()} wrapMode="none" flexShrink={0}>
                  {" "}
                  none
                </text>
              }
            >
              <For each={abilityEntries(data())}>
                {(entry) => (
                  <text fg={toneColour(theme(), entry.tone)} wrapMode="none" flexShrink={0}>
                    {" "}
                    {entry.label}
                  </text>
                )}
              </For>
            </Show>
          </box>
        </Show>
      </box>

      <box flexDirection="column">
        <text fg={action()} wrapMode="none" truncate onMouseUp={() => void props.onSetEndpoint()}>
          set instance url
        </text>
        <text fg={action()} wrapMode="none" truncate onMouseUp={() => void props.onSetToken()}>
          set api token
        </text>
        <text fg={action()} wrapMode="none" truncate onMouseUp={() => void refreshAccess()}>
          {refreshing() ? "refreshing access…" : "refresh access"}
        </text>
        <text fg={theme().muted} wrapMode="none" truncate onMouseUp={close}>
          close
        </text>
      </box>
    </box>
  )
}

/** The team name, or a short form of the host when no team is readable. */
function instanceHint(data: ApplicationsPayload | undefined): string {
  if (data?.connected !== true) return data?.endpointConfigured ? "not connected" : "not configured"
  const endpoint = data.endpoint
  if (!endpoint) return "connected"
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

/** The four abilities, in display order, with the short label each shows. */
const ABILITIES: ReadonlyArray<readonly [key: string, label: string]> = [
  ["read", "read"],
  ["write", "write"],
  ["deploy", "deploy"],
  ["read:sensitive", "secrets"],
]

export interface AbilityEntry {
  readonly key: string
  readonly label: string
  readonly status: "granted" | "denied" | "unknown"
  readonly tone: LineTone
}

/** One coloured entry per ability, so the line shows status per ability. */
export function abilityEntries(capabilities: CapabilitiesPayload | undefined): readonly AbilityEntry[] {
  const probes = capabilities?.probes ?? {}
  return ABILITIES.map(([key, label]) => {
    const status = probes[key]?.status ?? "unknown"
    return {
      key,
      label,
      status,
      tone: status === "granted" ? "ok" : status === "denied" ? "bad" : "muted",
    }
  })
}

/**
 * How much access the token has, as a 0-4 step. Zero means every ability was
 * refused, four means all of them were granted. Kept separate from the tone
 * vocabulary because the scale needs more than three steps.
 */
export function accessLevel(capabilities: CapabilitiesPayload | undefined): number {
  return abilityEntries(capabilities).filter((entry) => entry.status === "granted").length
}

/** Where a `/coolify` invocation should land. */
export type CoolifyAspect =
  | "hub"
  | "instance"
  | "token"
  | "access"
  | "apps"
  | "link"
  | "link-model"
  | "deploy"
  | "unknown"

/** The aspects `/coolify` accepts, in help order. */
export const COOLIFY_ASPECTS = ["instance", "token", "access", "apps", "link", "link model", "deploy"] as const

/**
 * Route the text after `/coolify` to an aspect.
 *
 * Tolerant on purpose: with `arguments: true` the runtime may hand back the raw
 * prompt text, so a leading `/coolify` (or a `/coolify-token` style alias) is
 * stripped before matching, and the obvious synonyms are accepted. An
 * unrecognised word is reported rather than quietly opening the hub — a typo
 * that silently does something else is worse than one that says it did not
 * understand.
 */
export function parseCoolifyArgument(input: string | undefined): CoolifyAspect {
  const rest = (input ?? "")
    .trim()
    .replace(/^\/?coolify[-:\s]*/i, "")
    .trim()
    .toLowerCase()
  if (rest === "") return "hub"

  const [first, second] = rest.split(/\s+/)
  switch (first) {
    case "instance":
    case "url":
    case "endpoint":
      return "instance"
    case "token":
    case "key":
      return "token"
    case "access":
    case "status":
    case "capabilities":
      return "access"
    case "apps":
    case "applications":
    case "all":
      return "apps"
    case "deploy":
      return "deploy"
    case "model":
      return "link-model"
    case "link":
      return second === "model" || second === "with-model" ? "link-model" : "link"
    default:
      return "unknown"
  }
}

/** Applications already resolved for this directory, or a config on disk. */
export function isLinked(payload: ApplicationsPayload | undefined): boolean {
  if (payload === undefined) return false
  if (payload.configFile !== undefined) return true
  if ((payload.apps ?? []).length > 0) return true
  return (payload.projects ?? []).some((project) => project.apps.length > 0)
}

/**
 * Whether the Configure entry point is worth showing.
 *
 * It exists to link an unlinked project and to fix the instance, so once the
 * instance answers and the project is already linked there is nothing behind it
 * but a redundant re-link. Hidden then, it reappears the moment either half
 * breaks — which is also when the token's access detail, shown inside it, is
 * worth reading.
 */
export function shouldShowConfigure(payload: ApplicationsPayload | undefined): boolean {
  if (payload?.connected !== true) return true
  return !isLinked(payload)
}

/** A restarted application or database the sidebar should mark as coming back up. */
export interface StartingUp {
  /** The application or database UUID the row is tracked by. */
  readonly id: string
  /** When the restart was noticed (detected or triggered locally). */
  readonly startedAt: number
}

/**
 * Whether an application row looks mid-restart: a container in a transitional
 * state, or a deployment that has been queued or is running.
 */
export function isStartingSignal(app: AppStatusPayload): boolean {
  const state = app.runtime?.state
  if (state === "starting" || state === "restarting" || state === "exited") return true
  const status = normalizeDeploymentStatus(app.latestDeployment?.status)
  return status === "queued" || status === "in_progress"
}

/** The previous poll showed the application up, so a change is a restart. */
function wasUp(app: AppStatusPayload): boolean {
  if (app.runtime?.state === "running") return true
  if (app.runtime?.health === "healthy") return true
  return normalizeDeploymentStatus(app.latestDeployment?.status) === "finished"
}

/**
 * Whether a database row looks mid-restart. Databases have no deployment
 * queue, so this is the container state alone.
 */
export function isDatabaseStartingSignal(database: DatabaseStatusPayload): boolean {
  const state = database.runtime?.state
  return state === "starting" || state === "restarting" || state === "exited"
}

/** The previous poll showed the database up, so a change is a restart. */
function wasDatabaseUp(database: DatabaseStatusPayload): boolean {
  return database.runtime?.state === "running" || database.runtime?.health === "healthy"
}

/** Mark a resource as starting up because the sidebar itself restarted it. */
export function markStartingUp(
  existing: readonly StartingUp[],
  id: string,
  now: number,
): readonly StartingUp[] {
  if (existing.some((entry) => entry.id === id)) return existing
  return [...existing, { id, startedAt: now }]
}

/**
 * Which tracked rows are starting up, given the last two polls and the set
 * already being followed.
 *
 * A row enters the set when the previous poll showed it up and this one shows a
 * restart signal — including restarts the plugin never triggered, such as a
 * change made in the Coolify UI. It leaves once the signal is gone and the
 * minimum spin has elapsed, or after the timeout, so it can never spin forever.
 *
 * Applications and databases reconcile separately, so an id only has to be
 * unique within its own list; this is the shared body.
 */
function reconcileRestarts<Row>(
  existing: readonly StartingUp[],
  previous: readonly Row[],
  next: readonly Row[],
  now: number,
  timeoutMs: number,
  identify: (row: Row) => string | undefined,
  isSignal: (row: Row) => boolean,
  isUp: (row: Row) => boolean,
): readonly StartingUp[] {
  const previousById = new Map<string, Row>()
  for (const row of previous) {
    const id = identify(row)
    if (id !== undefined) previousById.set(id, row)
  }
  const existingById = new Map(existing.map((entry) => [entry.id, entry]))
  const result: StartingUp[] = []

  for (const row of next) {
    const id = identify(row)
    if (id === undefined) continue
    const held = existingById.get(id)
    const signal = isSignal(row)
    if (held) {
      if (now - held.startedAt >= timeoutMs) continue
      if (signal || now - held.startedAt < STARTING_MIN_SPIN_MS) result.push(held)
      continue
    }
    const before = previousById.get(id)
    // A resource that was never up cannot be "restarting" — it is simply
    // stopped or never deployed, and should not claim a spinner.
    if (before && isUp(before) && signal) {
      result.push({ id, startedAt: now })
    }
  }

  return result
}

export function reconcileStartingUp(
  existing: readonly StartingUp[],
  previous: readonly AppStatusPayload[],
  next: readonly AppStatusPayload[],
  now: number,
  timeoutMs: number = STARTING_TIMEOUT_MS,
): readonly StartingUp[] {
  return reconcileRestarts(
    existing,
    previous,
    next,
    now,
    timeoutMs,
    (app) => app.applicationUUID,
    isStartingSignal,
    wasUp,
  )
}

export function reconcileStartingDatabases(
  existing: readonly StartingUp[],
  previous: readonly DatabaseStatusPayload[],
  next: readonly DatabaseStatusPayload[],
  now: number,
  timeoutMs: number = STARTING_TIMEOUT_MS,
): readonly StartingUp[] {
  return reconcileRestarts(
    existing,
    previous,
    next,
    now,
    timeoutMs,
    (database) => database.databaseUUID,
    isDatabaseStartingSignal,
    wasDatabaseUp,
  )
}

/**
 * How long until the next automatic refresh: soon while a deployment is in
 * flight or a restart is settling, leisurely when nothing is happening. The
 * active cadence stays below the idle one even when a small idle cadence is
 * configured, so "active" is always faster.
 */
export function refreshSeconds(
  apps: readonly AppStatusPayload[],
  idleSeconds: number = REFRESH_SECONDS_IDLE,
  starting: readonly StartingUp[] = [],
  startingDatabases: readonly StartingUp[] = [],
): number {
  const startingIDs = new Set(starting.map((entry) => entry.id))
  const active =
    startingDatabases.length > 0 ||
    apps.some((app) => {
      if (startingIDs.has(app.applicationUUID)) return true
      const status = normalizeDeploymentStatus(app.latestDeployment?.status)
      return status === "queued" || status === "in_progress"
    })
  return active ? activeCadence(idleSeconds) : idleSeconds
}

function activeCadence(idleSeconds: number): number {
  return Math.max(1, Math.min(REFRESH_SECONDS_ACTIVE, idleSeconds - 1))
}

/** One environment's rows inside a config section. */
export interface ApplicationEnvironmentView {
  /** The Coolify environment name, absent when the application reported none. */
  readonly environment?: string
  readonly apps: readonly AppStatusPayload[]
}

/** One rendered section of the sidebar: a config and its applications. */
export interface ApplicationGroupView {
  /** Shown only when the payload carries more than one config. */
  readonly heading?: string
  readonly configFile?: string
  readonly apps: readonly AppStatusPayload[]
  /** Databases the same config maps, in map order. */
  readonly databases: readonly DatabaseStatusPayload[]
  /** The same applications, split by environment, in first-seen order. */
  readonly environments: readonly ApplicationEnvironmentView[]
  /**
   * Whether each environment's name is printed above its rows.
   *
   * True whenever the project defines more than one environment, even if only
   * one currently has rows — otherwise a project with `production` and
   * `staging` but apps in only one would show the lone group unlabelled. Kept
   * here rather than derived at render time because only the payload knows the
   * project's full environment inventory.
   */
  readonly showEnvironments: boolean
}

/**
 * Whether a section labels its environment groups.
 *
 * The project's inventory is the authority, so a multi-environment project is
 * labelled even when just one has apps. A config that maps apps across several
 * environments still labels when the inventory could not be read.
 */
export function shouldLabelEnvironments(
  groups: readonly ApplicationEnvironmentView[],
  knownEnvironments: readonly string[] | undefined,
): boolean {
  return (knownEnvironments?.length ?? 0) > 1 || groups.length > 1
}

/**
 * Split a config's applications by Coolify environment, keeping first-seen
 * order.
 *
 * A `coolify.json` maps one entry per environment — `api` and `api-staging`
 * both deploying an application Coolify calls `api` — so grouping by
 * environment is what stops those rows looking like duplicates.
 */
export function environmentGroups(apps: readonly AppStatusPayload[]): readonly ApplicationEnvironmentView[] {
  const order: string[] = []
  const byEnvironment = new Map<string, AppStatusPayload[]>()
  for (const app of apps) {
    const key = app.environment ?? ""
    const bucket = byEnvironment.get(key)
    if (bucket) bucket.push(app)
    else {
      byEnvironment.set(key, [app])
      order.push(key)
    }
  }
  return order.map((key) => ({
    ...(key === "" ? {} : { environment: key }),
    apps: byEnvironment.get(key) ?? [],
  }))
}

/**
 * The config's repo-relative directory, for the section heading.
 *
 * The repository root has no useful directory label, so its `projectUUID`
 * stands in. Returns `undefined` at the root when there is no UUID, which
 * suppresses the heading rather than printing a placeholder.
 */
export function projectGroupHeading(project: ApplicationsProjectPayload): string | undefined {
  const relative = project.relativeFile
  const slash = relative.lastIndexOf("/")
  const directory = slash === -1 ? "" : relative.slice(0, slash)
  if (directory !== "" && directory !== ".") return directory
  return project.projectUUID
}

/**
 * Split a payload into the sections the sidebar renders.
 *
 * One config (or none) keeps today's layout: a single, headingless group from
 * the top-level `apps`. Two or more render one heading per config, so the
 * grouping lives here where it can be unit tested.
 */
export function applicationGroups(payload: ApplicationsPayload | undefined): readonly ApplicationGroupView[] {
  const projects = payload?.projects ?? []
  if (projects.length > 1) {
    return projects.map((project) => {
      const heading = projectGroupHeading(project)
      const environments = environmentGroups(project.apps)
      return {
        ...(heading === undefined ? {} : { heading }),
        configFile: project.configFile,
        apps: project.apps,
        databases: project.databases ?? [],
        environments,
        showEnvironments: shouldLabelEnvironments(environments, project.environments),
      }
    })
  }
  const apps = payload?.apps ?? []
  const environments = environmentGroups(apps)
  return [
    {
      ...(payload?.configFile === undefined ? {} : { configFile: payload.configFile }),
      apps,
      databases: payload?.databases ?? [],
      environments,
      showEnvironments: shouldLabelEnvironments(environments, payload?.environments),
    },
  ]
}

/**
 * How many application and database rows the body may show, from the terminal
 * height.
 *
 * The affordance lines (`+N more · show all`) are deliberately not counted:
 * they are the way back to the hidden rows and must never be squeezed out.
 */
export function sidebarRowBudget(terminalHeight: number): number {
  return Math.max(MIN_BODY_ROWS, Math.floor(terminalHeight) - SIDEBAR_CHROME_ROWS)
}

/** One environment's visible applications after the budget is applied. */
export interface PlannedEnvironment {
  /** The Coolify environment name, absent when the application reported none. */
  readonly environment?: string
  readonly apps: readonly AppStatusPayload[]
}

/**
 * A group after the shared row budget is applied: the rows that fit, and how
 * many each section had to leave out.
 */
export interface PlannedGroup {
  /** Shown only when the payload carries more than one config. */
  readonly heading?: string
  readonly configFile?: string
  readonly showEnvironments: boolean
  readonly environments: readonly PlannedEnvironment[]
  /** Databases that fit, in map order. */
  readonly databases: readonly DatabaseStatusPayload[]
  /** Applications in the group, before the budget. */
  readonly appCount: number
  /** Databases in the group, before the budget. */
  readonly databaseCount: number
  /** Applications the budget could not fit. */
  readonly hiddenApps: number
  /** Databases the budget could not fit. */
  readonly hiddenDatabases: number
}

/**
 * Apply one row budget across every group, in render order.
 *
 * Applications and databases draw from the same pool, so a project with many
 * databases leaves less room for applications and vice versa. Headings and
 * environment labels are free — one line each, and they identify the rows that
 * follow — while a truncation notice is rendered outside the budget, since it
 * is the way back to the hidden rows.
 */
export function planSidebarRows(
  groups: readonly ApplicationGroupView[],
  budget: number,
): readonly PlannedGroup[] {
  let remaining = Math.max(0, Math.floor(budget))
  const planned: PlannedGroup[] = []

  for (const group of groups) {
    const environments: PlannedEnvironment[] = []
    let hiddenApps = 0
    for (const environment of group.environments) {
      const visible = environment.apps.slice(0, remaining)
      remaining -= visible.length
      hiddenApps += environment.apps.length - visible.length
      environments.push({
        ...(environment.environment === undefined ? {} : { environment: environment.environment }),
        apps: visible,
      })
    }

    const databases = group.databases.slice(0, remaining)
    remaining -= databases.length

    planned.push({
      ...(group.heading === undefined ? {} : { heading: group.heading }),
      ...(group.configFile === undefined ? {} : { configFile: group.configFile }),
      showEnvironments: group.showEnvironments,
      environments,
      databases,
      appCount: group.apps.length,
      databaseCount: group.databases.length,
      hiddenApps,
      hiddenDatabases: group.databases.length - databases.length,
    })
  }

  return planned
}

export function appRowTone(app: AppStatusPayload): LineTone {
  if (app.runtime && (app.runtime.state !== "unknown" || app.runtime.health !== "none")) {
    return runtimeTone(app.runtime)
  }
  const status = (app.latestDeployment?.status ?? "").toLowerCase()
  if (status === "") return "unknown"
  if (status === "failed" || status === "error") return "bad"
  if (status === "finished" || status === "success" || status === "succeeded") return "ok"
  return "warn"
}

/**
 * The compact state shown at the right of a row. Health is folded into the
 * status light, so only an unhealthy container needs a marker of its own.
 */
export function appRowState(app: AppStatusPayload): string {
  const runtime = app.runtime
  if (runtime && (runtime.state !== "unknown" || runtime.health !== "none")) {
    return runtime.health === "unhealthy" ? `${runtime.state} !` : runtime.state
  }
  return app.latestDeployment?.status ?? "not deployed"
}

/** The full, unabbreviated form, for dialogs and tool output. */
export function appRowLabel(app: AppStatusPayload): string {
  return `${app.name} · ${appRowState(app)}`
}

/** A database's status light, derived from the same runtime vocabulary. */
export function databaseRowTone(database: DatabaseStatusPayload): LineTone {
  return database.runtime ? runtimeTone(database.runtime) : "unknown"
}

/**
 * The compact state shown at the right of a database row. With no runtime —
 * a config entry that could not be resolved, or a failed fetch — the type is
 * more use than the word "unknown".
 */
export function databaseRowState(database: DatabaseStatusPayload): string {
  if (database.runtime) {
    return database.runtime.health === "unhealthy" ? `${database.runtime.state} !` : database.runtime.state
  }
  return database.type ?? "unknown"
}

/** The full, unabbreviated form, for dialogs and tool output. */
export function databaseRowLabel(database: DatabaseStatusPayload): string {
  return `${database.name} · ${databaseRowState(database)}`
}

export function statusLight(tone: LineTone): string {
  if (tone === "ok") return "●"
  if (tone === "warn") return "◐"
  if (tone === "bad") return "○"
  if (tone === "muted") return "·"
  return "◌"
}

function toneColour(
  theme: { base: string; muted: string; feedback: { success: { base: string }; warning: { base: string }; error: { base: string } } },
  tone: LineTone,
): string {
  if (tone === "ok") return theme.feedback.success.base
  if (tone === "warn") return theme.feedback.warning.base
  if (tone === "bad") return theme.feedback.error.base
  return theme.muted
}

/**
 * A one-line project label: `~` for home and one letter per parent folder.
 *
 * `/home/me/programming/client/inventory.app` becomes `~/p/c/inventory.app`.
 * The final segment is kept whole so the project is still recognisable, and
 * nothing is elided — the full path is shown on click instead.
 */
export function abbreviatePath(value: string, home: string | undefined = process.env.HOME): string {
  const trimmed = value.replace(/\/+$/, "")
  if (trimmed === "") return "/"

  let prefix = ""
  let rest = trimmed
  if (home && home !== "/" && (trimmed === home || trimmed.startsWith(`${home}/`))) {
    prefix = "~"
    rest = trimmed.slice(home.length)
  }
  const absolute = rest.startsWith("/")
  const segments = rest.split("/").filter((segment) => segment !== "")
  if (segments.length === 0) return prefix === "~" ? "~" : "/"

  const shortened = segments.map((segment, index) =>
    index === segments.length - 1 || segment.length <= 1 ? segment : segment.slice(0, 1),
  )
  const joined = shortened.join("/")
  if (prefix === "~") return `~/${joined}`
  return absolute ? `/${joined}` : joined
}

/** The last path segment, for a compact project label. */
export function basename(value: string): string {
  const trimmed = value.replace(/\/+$/, "")
  return trimmed.split("/").pop() ?? trimmed
}

function slug(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
