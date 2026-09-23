/** @jsxImportSource @opentui/solid */
import type { Integration } from "@opencode/plugin"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { KeymapLayer } from "@opencode/plugin/tui/context"
import { TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { normalizeDeploymentStatus } from "./coolify/deploy"
import { runtimeTone, type RuntimeTone } from "./coolify/runtime"
import { DEFAULT_REFRESH_SECONDS } from "./options"
import { DEPLOY_SKILL, LINK_SKILL, type CoolifySkill } from "./skills"
import {
  Coolify as CoolifyRpc,
  type ApplicationsPayload,
  type ApplicationsProjectPayload,
  type AppStatusPayload,
  type CapabilitiesPayload,
  type CandidatePayload,
  type ResolvePayload,
} from "./rpc"

const INTEGRATION_ID = "coolify" as Integration.ID
/** How many application rows the sidebar shows before it stops. */
const MAX_ROWS = 4
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
  readonly markStarting: (applicationUUID: string) => void
  /** Drives the sidebar's loading indicator during a show-all fetch. */
  readonly setBusy: (value: boolean) => void
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
     * "Show all" gets clicked repeatedly, and the project list changes far less
     * often than the mapped one, so a short cache avoids a round trip per click.
     */
    let allAppsCache: { at: number; directory: string | undefined; apps: readonly AppStatusPayload[] } | undefined
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
    async function runInSideChat(title: string, skill: CoolifySkill, text: string): Promise<boolean> {
      // `promptInput`, not `message`: `message` is the error formatter below.
      const promptInput = { text, skills: [{ id: skill.id }] }
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
          permissions: [{ action: "coolify.read", resource: "*", effect: "allow" }],
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
      await runInSideChat(app ? `Deploy ${app.name}` : "Coolify deploy", DEPLOY_SKILL, text)
    }

    /** The model-driven linking: needed for a monorepo, or when nothing matches. */
    async function linkWithModel(): Promise<boolean> {
      return await runInSideChat("Link repository", LINK_SKILL, "Link this repository to its Coolify applications.")
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

    async function showLogs(app: AppStatusPayload | undefined): Promise<void> {
      const result = (await rpc.logs({ applicationUUID: app?.applicationUUID, lines: 80 })) as {
        logs?: string
        message?: string
      }
      const body = result.logs?.trim() ? result.logs.slice(-3_000) : (result.message ?? "No logs.")
      await context.ui.dialog.alert({ title: `Logs · ${app?.name ?? "application"}`, message: body })
    }

    /**
     * App-level actions only. Project-level concerns (linking, instance) live on
     * their own dedicated buttons, so this dialog never mixes the two.
     */
    async function openAppActions(app: AppStatusPayload): Promise<void> {
      const choice = await context.ui.dialog.select<string>({
        title: app.name,
        options: [
          { title: "Deploy in a side chat", value: "deploy", description: "opens a background tab" },
          { title: "View logs", value: "logs" },
          { title: "Restart", value: "restart" },
          { title: "Roll back to a commit", value: "rollback" },
        ],
      })
      if (!choice) return

      try {
        if (choice === "deploy") return await deployInSideChat(app)
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
     * Every application in the project, for when the sidebar list is truncated
     * or an app is not linked to this repository yet.
     */
    async function openAllApps(directory: string | undefined): Promise<void> {
      const ALL_APPS_TTL_MS = 10_000
      let apps: readonly AppStatusPayload[]

      sidebarControls?.setBusy(true)
      try {
        const cached =
          allAppsCache && allAppsCache.directory === directory && Date.now() - allAppsCache.at < ALL_APPS_TTL_MS
        if (cached) {
          apps = allAppsCache!.apps
        } else {
          const data = (await callRpc(rpc.applications, { scope: "project", directory }, directory)) as ApplicationsPayload
          apps = data.apps ?? []
          allAppsCache = { at: Date.now(), directory, apps }
        }
      } catch (cause) {
        toast(`Could not list applications: ${message(cause)}`, "error")
        return
      } finally {
        sidebarControls?.setBusy(false)
      }

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
          onAppActions={openAppActions}
          onAllApps={() => openAllApps(sessionDirectory())}
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
  onAppActions: (app: AppStatusPayload) => Promise<void>
  onAllApps: () => Promise<void>
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
  let inFlight: Promise<void> | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  /** The rows from the previous poll, used to spot a restart we did not trigger. */
  let previousRows: readonly AppStatusPayload[] = []

  // `rows` feeds the countdown's active-deployment check; grouping only
  // affects what is drawn, not when the sidebar refreshes.
  const rows = createMemo(() => (data()?.apps ?? []).slice(0, MAX_ROWS))
  const idleSeconds = (): number => data()?.refreshSeconds ?? REFRESH_SECONDS_IDLE
  const isStarting = (app: AppStatusPayload): boolean =>
    starting().some((entry) => entry.applicationUUID === app.applicationUUID)
  const groups = createMemo(() => applicationGroups(data()))
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
   * Coalesced: concurrent callers share one request. During a deployment the
   * server emits progress every few seconds, and without this each event would
   * start its own round trip.
   */
  const load = (): Promise<void> => {
    if (inFlight) return inFlight
    setBusy(true)
    let cadence = idleSeconds()
    inFlight = (async () => {
      try {
        // The RPC `location` option is not honoured, so the directory travels in
        // the input instead. Without it the server answers for its own default
        // location and a freshly mapped project shows nothing.
        const base = directory()
        setNoDirectory(base === undefined)
        const payload = (await callRpc(rpc.applications, {
          scope: "mapped",
          ...(base === undefined ? {} : { directory: base }),
        }, base)) as ApplicationsPayload
        const nextRows = payload.apps ?? []
        cadence = payload.refreshSeconds ?? REFRESH_SECONDS_IDLE
        const nextStarting = reconcileStartingUp(starting(), previousRows, nextRows, Date.now(), STARTING_TIMEOUT_MS)
        previousRows = nextRows
        setStarting(nextStarting)
        setData(payload)
        setFailed(false)
        cadence = refreshSeconds(nextRows, cadence, nextStarting)
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
      void load()
    }, delayMs)
  }

  onMount(() => {
    void load()
    props.onReady({
      refresh: () => void load(),
      markStarting: (applicationUUID) =>
        setStarting((existing) => markStartingUp(existing, applicationUUID, Date.now())),
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
    if (!busy() && starting().length === 0) return
    const id = setInterval(() => setFrame((value) => value + 1), 100)
    onCleanup(() => clearInterval(id))
  })

  return (
    <box flexDirection="column">
      {/* Title: instance, then the working directory it is answering for. The
          directory is on screen because a wrong project is otherwise invisible,
          which is exactly how a shared-state bug hides. */}
      <box flexDirection="row" gap={1} onMouseUp={() => void load()}>
        <text attributes={TextAttributes.BOLD} fg={theme().base} flexShrink={0}>
          Coolify
        </text>
        <Show when={busy()}>
          <text fg={theme().feedback.info?.base ?? theme().base} flexShrink={0}>
            {SPINNER[frame() % SPINNER.length]}
          </text>
        </Show>
        <text
          fg={failed() ? theme().feedback.error.base : theme().muted}
          wrapMode="none"
          truncate
          flexShrink={1}
          minWidth={0}
        >
          {failed() ? "unreachable" : (data()?.capabilities?.team?.name ?? instanceHint(data()))}
        </text>
        <text fg={theme().muted} wrapMode="none" flexShrink={0}>
          ·
        </text>
        <text
          fg={noDirectory() ? theme().feedback.warning.base : theme().muted}
          wrapMode="none"
          truncate
          flexShrink={1}
          minWidth={0}
        >
          {noDirectory() ? "no project directory" : basename(directory() ?? "")}
        </text>
        <box flexGrow={1} />
        <text fg={theme().muted} wrapMode="none" flexShrink={0}>
          {remaining()}s
        </text>
      </box>

      {/* Applications: status light, name, state. One section per config. */}
      <box border={["top"]} borderColor={theme().muted} flexDirection="column">
        <For each={groups()}>
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
                        environment, so the environment is a section of its
                        own whenever a config spans more than one. */}
                    <Show when={group.environments.length > 1}>
                      <text fg={theme().muted} wrapMode="none" truncate>
                        {environment.environment ?? "no environment"}
                      </text>
                    </Show>

                    <For each={environment.apps.slice(0, MAX_ROWS)}>
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

              <Show when={group.apps.length > MAX_ROWS}>
                <box flexDirection="row" gap={1} onMouseUp={() => void props.onAllApps()}>
                  <Show when={busy()}>
                    <text fg={theme().feedback.info?.base ?? theme().base}>{SPINNER[frame() % SPINNER.length]}</text>
                  </Show>
                  <text fg={theme().muted} wrapMode="none" truncate>
                    {busy() ? "loading…" : `+${group.apps.length - MAX_ROWS} more · show all`}
                  </text>
                </box>
              </Show>

              <Show when={!failed() && data()?.connected && group.apps.length === 0}>
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
      <text attributes={TextAttributes.BOLD} fg={theme().base}>
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
      <text attributes={TextAttributes.BOLD} fg={theme().base}>
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

/** A restarted application the sidebar should mark as coming back up. */
export interface StartingUp {
  readonly applicationUUID: string
  /** When the restart was noticed (detected or triggered locally). */
  readonly startedAt: number
}

/**
 * Whether a row looks mid-restart: a container in a transitional state, or a
 * deployment that has been queued or is running.
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

/** Mark an application as starting up because the sidebar itself restarted it. */
export function markStartingUp(
  existing: readonly StartingUp[],
  applicationUUID: string,
  now: number,
): readonly StartingUp[] {
  if (existing.some((entry) => entry.applicationUUID === applicationUUID)) return existing
  return [...existing, { applicationUUID, startedAt: now }]
}

/**
 * Which applications are starting up, given the last two polls and the set
 * already being followed.
 *
 * A row enters the set when the previous poll showed it up and this one shows a
 * restart signal — including restarts the plugin never triggered, such as a
 * change made in the Coolify UI. It leaves once the signal is gone and the
 * minimum spin has elapsed, or after the timeout, so it can never spin forever.
 */
export function reconcileStartingUp(
  existing: readonly StartingUp[],
  previous: readonly AppStatusPayload[],
  next: readonly AppStatusPayload[],
  now: number,
  timeoutMs: number = STARTING_TIMEOUT_MS,
): readonly StartingUp[] {
  const previousById = new Map(previous.map((app) => [app.applicationUUID, app]))
  const existingById = new Map(existing.map((entry) => [entry.applicationUUID, entry]))
  const result: StartingUp[] = []

  for (const app of next) {
    const held = existingById.get(app.applicationUUID)
    const signal = isStartingSignal(app)
    if (held) {
      if (now - held.startedAt >= timeoutMs) continue
      if (signal || now - held.startedAt < STARTING_MIN_SPIN_MS) result.push(held)
      continue
    }
    const before = previousById.get(app.applicationUUID)
    // An application that was never up cannot be "restarting" — it is simply
    // stopped or never deployed, and should not claim a spinner.
    if (before && wasUp(before) && signal) {
      result.push({ applicationUUID: app.applicationUUID, startedAt: now })
    }
  }

  return result
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
): number {
  const startingIDs = new Set(starting.map((entry) => entry.applicationUUID))
  const active = apps.some((app) => {
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
  /** The same applications, split by environment, in first-seen order. */
  readonly environments: readonly ApplicationEnvironmentView[]
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
      return {
        ...(heading === undefined ? {} : { heading }),
        configFile: project.configFile,
        apps: project.apps,
        environments: environmentGroups(project.apps),
      }
    })
  }
  const apps = payload?.apps ?? []
  return [
    {
      ...(payload?.configFile === undefined ? {} : { configFile: payload.configFile }),
      apps,
      environments: environmentGroups(apps),
    },
  ]
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
