import { Integration, Plugin } from "@opencode/plugin"
import { writeFile } from "node:fs/promises"
import { AbsolutePath } from "@opencode/schema/schema"
import { ID as SkillID, Info as SkillInfo, Name as SkillName } from "@opencode/schema/skill"
import { relative as relativePath } from "node:path"
import { probeCapabilities } from "./coolify/capabilities"
import { CoolifyClient, normalizeEndpoint } from "./coolify/client"
import {
  cancelDeployment,
  getDeployment,
  isTerminal,
  listApplicationDeployments,
  listDeployments,
  triggerDeploy,
  waitForDeployment,
} from "./coolify/deploy"
import {
  restartApplication,
  rollbackApplication,
  startApplication,
  stopApplication,
} from "./coolify/resources"
import { getApplication, listEnvironments } from "./coolify/resources"
import { databaseRuntime, getDatabase, listDatabases, type CoolifyDatabase } from "./coolify/databases"
import {
  describeError,
  granted,
  type Capability,
  type CapabilityReport,
  type CoolifyDeployment,
  type CoolifyEnvironment,
} from "./coolify/types"
import { normalizeDeploymentStatus, parseApplicationStatus } from "@skyvence/coolify-oc-shared/coolify/runtime"
import { parseRecursiveProjects, parseRefreshSeconds } from "@skyvence/coolify-oc-shared/options"
import {
  databasesFor,
  findAllProjectConfigs,
  findProjectConfig,
  findRepositoryRoot,
  selectApplication,
  updateProjectConfig,
  validateProjectJson,
  type ProjectConfig,
  type ProjectConfigDatabase,
} from "./project-config"
import { configFileFor } from "./tools/create"
import { asApplicationMap, asDatabaseMap, nonEmpty } from "./tools/shared"
import { latestDeploymentFor } from "./tools/shared"
import {
  Coolify as CoolifyRpc,
  type ApplicationsPayload,
  type ApplicationsProjectPayload,
  type AppStatusPayload,
  type CapabilitiesPayload,
  type DatabaseStatusPayload,
} from "@skyvence/coolify-oc-shared/rpc"
import { resolveProject } from "./resolve"
import { COOLIFY_SKILLS, skillPath } from "@skyvence/coolify-oc-shared/skills"
import {
  clearLink,
  readCapabilities,
  readLink,
  readSettings,
  writeCapabilities,
  writeLink,
  writeSettings,
  type ResolvedLink,
  type StorageLike,
} from "./store"
import { buildTools } from "./tools"

export const INTEGRATION_ID = Integration.ID.make("coolify")

export default Plugin.define({
  id: "opencode.coolify",
  async setup(ctx) {
    const store = ctx.storage as unknown as StorageLike
    const projectID = ctx.location.project.id

    // Settings are plugin-scoped, so they survive across projects and TUI restarts.
    let settings = await readSettings(store)

    let normalizedEndpoint = normalizeOrUndefined(readEndpoint(ctx.options) ?? settings.endpoint)

    /** Idle sidebar cadence, chosen by the `refreshSeconds` option. */
    const refreshSeconds = parseRefreshSeconds(ctx.options.refreshSeconds)
    /** One section per config in the repository. Off unless asked for. */
    const recursiveProjects = parseRecursiveProjects(ctx.options.recursiveProjects)

    /**
     * Re-read the endpoint from storage.
     *
     * Storage is shared by every instance with this plugin id, so the setting
     * can change underneath a long-running one — written from another location,
     * or by a CLI call. Reading it only at setup left such an instance insisting
     * the plugin was unconfigured until it restarted, which looks exactly like a
     * wiped config. Options win over storage, as they do at setup.
     *
     * A change invalidates the cached report and client, both of which belong to
     * the old endpoint.
     */
    async function syncEndpoint(): Promise<void> {
      const previous = normalizedEndpoint
      const fromOptions = normalizeOrUndefined(readEndpoint(ctx.options))
      if (fromOptions) {
        normalizedEndpoint = fromOptions
      } else {
        settings = await readSettings(store)
        normalizedEndpoint = normalizeOrUndefined(settings.endpoint)
      }
      if (normalizedEndpoint === previous) return
      client = undefined
      capabilities = undefined
      // A different instance answers for a different endpoint, so every cached
      // payload belongs to the old one.
      invalidateApplications()
    }

    /** How long a capability report is trusted without a fresh probe. */
    const CAPABILITY_TTL_MS = 10 * 60 * 1_000

    let client: CoolifyClient | undefined
    let capabilities: CapabilityReport | undefined = normalizedEndpoint
      ? await readCapabilities(store, normalizedEndpoint)
      : undefined
    let link: ResolvedLink | undefined = await readLink(store, projectID)
    let credentialPresent = false
    /** In-flight probe, so concurrent refreshes share one burst. */
    let refreshing: Promise<void> | undefined

    /**
     * Recently built `applications` payloads.
     *
     * Each payload fans out into many Coolify calls — one per application, one
     * per project environment, plus the database lookups. Every open sidebar
     * asking for the same project used to pay that fan-out again on each poll
     * and on each re-mount, which multiplied the load by the number of sessions.
     * One entry per endpoint, scope and directory turns that back into a single
     * burst per refresh interval.
     *
     * The directory is part of the key on purpose: it is what selects the
     * `coolify.json`, so two checkouts of the same repository — including a
     * worktree — can never be served each other's state.
     */
    const applicationsCache = new Map<string, { at: number; payload: ApplicationsPayload }>()
    /** Builds in flight, so concurrent callers sharing a key share one fan-out. */
    const applicationsInFlight = new Map<string, Promise<ApplicationsPayload>>()
    /**
     * Even a `fresh` request reuses a payload this young. Several sessions'
     * sidebars all hear one deployment event and ask at once; without this each
     * would start its own fan-out. A second is short enough that no observer can
     * tell the answer came from cache.
     */
    const FRESH_COALESCE_MS = 1_000

    /** Drop every cached payload; the next read rebuilds from Coolify. */
    function invalidateApplications(): void {
      applicationsCache.clear()
    }

    // --- Integration: declare the integration and its API-key method ---------
    const integrationRegistration = await ctx.integration.transform((editor) => {
      editor.update(INTEGRATION_ID, (integration) => {
        integration.name = "Coolify"
      })
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "key", label: "Coolify API token" },
      })
    })

    // --- Tools --------------------------------------------------------------
    const toolRegistration = await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "coolify",
        description: "Deploy and inspect this project on a self-hosted Coolify instance.",
      })
      for (const tool of buildTools(toolDeps())) {
        editor.add({
          name: tool.name,
          description: tool.description,
          input: tool.input,
          // One permission action per tier, so a user can allow reads while
          // keeping writes, deploys or deletes asking (or deny them outright).
          options: { namespace: "coolify", permission: `coolify.${tool.tier}` },
          execute: async (input, context) => {
            try {
              const result = await tool.run(input, context)
              return { content: result.content, ...(result.metadata ? { metadata: result.metadata } : {}) }
            } catch (error) {
              // Failures become model-readable text rather than raw stack traces.
              return { content: `Coolify error: ${describeError(error)}`, metadata: { ok: false } }
            }
          },
        })
      }
    })

    // --- Skills -------------------------------------------------------------
    // The mapping and deploy instructions live here rather than inside the TUI,
    // so a client that exposes skills but not plugin tools can still use them.
    // Registering is idempotent, and `reload` re-runs the transform, so a hot
    // reload replaces the content instead of duplicating it. `skills.ts` stays
    // plain data; the runtime's branded types are applied only here.
    const skillRegistration = await ctx.skill.transform((editor) => {
      for (const skill of COOLIFY_SKILLS) {
        editor.add(
          SkillInfo.make({
            id: SkillID.make(skill.id),
            name: SkillName.make(skill.name),
            description: skill.description,
            path: AbsolutePath.make(skillPath(ctx.location.directory, skill.id)),
            content: skill.content,
          }),
        )
      }
    })

    // --- RPC ----------------------------------------------------------------
    const rpc = await ctx.rpc.register(CoolifyRpc, {
      capabilities: async () => {
        // The TUI reads this method directly for its setup popup and gating.
        // Reconcile the endpoint and credential first so those views cannot
        // lag behind the applications path or a server-side tool call.
        await refresh("capabilities")
        return capabilitiesPayload()
      },

      refreshCapabilities: async () => {
        await refresh("rpc", true)
        await ctx.tool.reload()
        emitCapabilities()
        return capabilitiesPayload()
      },

      setEndpoint: async (input) => {
        const raw = (input as { endpoint?: string } | undefined)?.endpoint
        if (typeof raw !== "string" || raw.trim() === "") {
          return { ok: false, message: "`endpoint` is required." }
        }
        const normalized = normalizeOrUndefined(raw)
        if (!normalized) {
          return { ok: false, message: `"${raw}" is not a usable Coolify URL.` }
        }
        normalizedEndpoint = normalized
        settings = { ...settings, endpoint: raw.trim() }
        await writeSettings(store, settings)
        invalidateApplications()
        await refresh("setEndpoint")
        await ctx.tool.reload()
        emitCapabilities()
        return { ok: true, endpoint: normalized }
      },

      resolve: async (input) => {
        const payload = input as { autoLink?: boolean; directory?: string } | undefined
        const directory = nonEmpty(payload?.directory)
        if (!directory) {
          return {
            source: "none",
            ambiguous: false,
            candidates: [],
            notes: ["No project directory was supplied, so there is nothing to resolve against."],
          }
        }
        const resolution = await resolveProject({
          store,
          projectID,
          directory,
          client,
          capabilities,
        })
        const autoLink = payload?.autoLink === true
        if (autoLink && resolution.source === "discovered" && resolution.best) {
          await setLink(linkFromCandidate(resolution.best))
        }
        return {
          source: resolution.source,
          ambiguous: resolution.ambiguous,
          ...(resolution.best ? { best: resolution.best } : {}),
          candidates: resolution.candidates,
          ...(link ?? resolution.link ? { link: link ?? resolution.link } : {}),
          ...(resolution.config ? { config: resolution.config } : {}),
          notes: resolution.notes,
        }
      },

      link: async (input) => {
        const payload = input as { applicationUUID?: string } & Record<string, unknown>
        const applicationUUID = payload?.applicationUUID
        if (typeof applicationUUID !== "string" || applicationUUID === "") {
          return { message: "`applicationUUID` is required." }
        }
        const application =
          client && granted(capabilities, "read")
            ? await getApplication(client, applicationUUID).catch(() => undefined)
            : undefined
        const next: ResolvedLink = application
          ? {
              applicationUUID: application.uuid,
              ...(application.name === undefined ? {} : { name: application.name }),
              ...(application.project_uuid === undefined ? {} : { projectUUID: application.project_uuid }),
              ...(application.environment_name === undefined ? {} : { environmentName: application.environment_name }),
              ...(application.server_uuid === undefined ? {} : { serverUUID: application.server_uuid }),
              ...(application.git_repository === undefined ? {} : { gitRepository: application.git_repository }),
              linkedAt: Date.now(),
              source: "pin",
            }
          : {
              applicationUUID,
              ...optionalString("name", payload.name),
              ...optionalString("projectUUID", payload.projectUUID),
              ...optionalString("environmentName", payload.environmentName),
              ...optionalString("serverUUID", payload.serverUUID),
              ...optionalString("gitRepository", payload.gitRepository),
              linkedAt: Date.now(),
              source: "pin",
            }
        await setLink(next)
        return { link: next }
      },

      unlink: async () => {
        await setLink(undefined)
        return { ok: true }
      },

      status: async (input) => {
        const override = (input as { applicationUUID?: string } | undefined)?.applicationUUID
        return statusPayload(override)
      },

      applications: async (input) => {
        const payload = input as { scope?: string; directory?: string; fresh?: boolean } | undefined
        return applicationsPayload(payload?.scope, payload?.directory, payload?.fresh === true)
      },

      configureProject: async (input) => configureProjectPayload(input as Record<string, unknown> | undefined),

      writeProjectJson: async (input) => writeProjectJsonPayload(input as Record<string, unknown> | undefined),

      logs: async (input) => {
        if (!client) return { logs: "", message: "No Coolify API token is connected." }
        const payload = input as { applicationUUID?: string; lines?: number } | undefined
        const target = await resolveTarget(payload?.applicationUUID)
        if (!target) return { logs: "", message: "No Coolify application is linked to this project." }
        const { getApplicationLogs } = await import("./coolify/resources")
        const logs = await getApplicationLogs(client, target, { lines: payload?.lines ?? 100 }).catch(() => "")
        return {
          logs,
          message:
            logs.trim() === ""
              ? "Coolify returned no logs. That usually means the token lacks read:sensitive rather than an empty container log."
              : "",
        }
      },

      deployment: async (input, context) => {
        const deploymentUUID = (input as { deploymentUUID?: string } | undefined)?.deploymentUUID
        if (typeof deploymentUUID !== "string" || deploymentUUID === "") {
          return { status: "unknown", logs: "", terminal: false, message: "`deploymentUUID` is required." }
        }
        if (!client) {
          return { status: "unknown", logs: "", terminal: false, message: "No Coolify API token is connected." }
        }
        const deployment = await getDeployment(client, deploymentUUID, context.signal).catch(() => undefined)
        if (!deployment) {
          return { status: "unknown", logs: "", terminal: false, message: "Coolify did not return that deployment." }
        }
        const status = normalizeDeploymentStatus(deployment.status)
        return {
          status,
          raw: deployment.status ?? "unknown",
          logs: typeof deployment.logs === "string" ? deployment.logs : "",
          ...(deployment.commit ? { commit: deployment.commit } : {}),
          ...(deployment.commit_message ? { commitMessage: deployment.commit_message } : {}),
          terminal: isTerminal(status),
        }
      },

      deploy: async (input, context) => {
        if (!client) return { message: "No Coolify API token is connected." }
        const payload = input as {
          action?: string
          applicationUUID?: string
          databaseUUID?: string
          deploymentUUID?: string
          commit?: string
          force?: boolean
          wait?: boolean
          pr?: number
        }
        const action = payload?.action ?? "deploy"

        if (action === "cancel") {
          if (!payload.deploymentUUID) return { message: "`deploymentUUID` is required to cancel." }
          const result = await cancelDeployment(client, payload.deploymentUUID, context.signal)
          return { message: result.message ?? "Cancellation requested." }
        }

        if (action === "start" || action === "stop" || action === "restart") {
          if (payload.databaseUUID) {
            const { startDatabase, stopDatabase, restartDatabase } = await import("./coolify/databases")
            const run = action === "start" ? startDatabase : action === "stop" ? stopDatabase : restartDatabase
            await run(client, payload.databaseUUID, context.signal)
            return { message: `${action} requested for database ${payload.databaseUUID}.` }
          }
          const target = await resolveTarget(payload.applicationUUID)
          if (!target) return { message: "No Coolify application is linked to this project." }
          const run = action === "start" ? startApplication : action === "stop" ? stopApplication : restartApplication
          await run(client, target, context.signal)
          return { message: `${action} requested for ${target}.` }
        }

        const target = await resolveTarget(payload?.applicationUUID)
        if (!target) return { message: "No Coolify application is linked to this project." }

        if (action === "rollback") {
          if (!payload.commit) return { message: "`commit` is required to roll back." }
          await rollbackApplication(client, target, payload.commit, context.signal)
          return { message: `Rollback requested for ${target} to ${payload.commit}.` }
        }

        const tickets = await triggerDeploy(
          client,
          {
            uuid: target,
            ...(payload?.force === true ? { force: true } : {}),
            ...(typeof payload?.pr === "number" ? { pr: payload.pr } : {}),
          },
          context.signal,
        )

        const first = tickets[0]
        if (!first?.deploymentUUID || payload?.wait === false) {
          return { tickets, message: "Deployment queued." }
        }

        const result = await waitForDeployment(client, first.deploymentUUID, {
          signal: context.signal,
          onProgress: (update) => {
            emitDeployProgress({
              applicationUUID: target,
              deploymentUUID: first.deploymentUUID,
              status: update.status,
              message: update.raw,
            })
          },
        })
        return {
          tickets,
          wait: { status: result.status, timedOut: result.timedOut, polls: result.polls },
        }
      },

      cancelDeployment: async (input, context) => {
        if (!client) return { message: "No Coolify API token is connected." }
        const deploymentUUID = (input as { deploymentUUID?: string } | undefined)?.deploymentUUID
        if (typeof deploymentUUID !== "string" || deploymentUUID === "") {
          return { message: "`deploymentUUID` is required." }
        }
        const result = await cancelDeployment(client, deploymentUUID, context.signal)
        return { message: result.message ?? "Cancellation requested.", ...(result.status ? { status: result.status } : {}) }
      },
    })

    // --- Credential changes re-probe abilities ------------------------------
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "credential.updated" && event.type !== "credential.switched") continue
          // Setting a token fires this, plus the TUI's own refresh call; the
          // force flag means whichever arrives first is the authoritative probe.
          // A different token can reach a different team or expose different
          // abilities, so any cached payloads no longer describe this instance.
          invalidateApplications()
          await refresh(`event:${event.type}`, true)
          await ctx.tool.reload()
          emitCapabilities()
        }
      } catch {
        // Subscription ends when the plugin unloads; nothing to report.
      }
    })()

    await refresh("setup")
    await ctx.tool.reload()

    return async () => {
      controller.abort()
      await integrationRegistration.dispose()
      await toolRegistration.dispose()
      await rpc.dispose()
    }

    // ---------------------------------------------------------------------

    function toolDeps() {
      return {
        store,
        projectID,
        directory: ctx.location.directory,
        endpoint: normalizedEndpoint,
        getClient: () => client,
        getCapabilities: () => capabilities,
        getLink: () => link,
        setLink: async (next: ResolvedLink | undefined) => {
          link = next
          // The link is what a config-less project falls back to, so a cached
          // payload for any directory may now be wrong.
          invalidateApplications()
          if (next) await writeLink(store, projectID, next)
          else await clearLink(store, projectID)
          await ctx.tool.reload()
          if (next) {
            void rpc.events.emit("link.changed", {
              projectID,
              applicationUUID: next.applicationUUID,
              source: next.source,
            })
          }
        },
        emitDeployProgress,
        emitProjectChanged,
      }
    }

    function emitDeployProgress(data: {
      applicationUUID: string
      deploymentUUID: string
      status: string
      message: string
    }): void {
      void rpc.events.emit("deploy.progress", data)
    }

    function emitCapabilities(): void {
      void rpc.events.emit("capabilities.changed", {
        endpoint: capabilities?.endpoint ?? normalizedEndpoint ?? "",
        read: capabilities?.probes.read.status ?? "unknown",
        write: capabilities?.probes.write.status ?? "unknown",
        deploy: capabilities?.probes.deploy.status ?? "unknown",
      })
    }

    /**
     * Re-probe the token's abilities.
     *
     * Single-flight, because setting a token fires `credential.updated` while
     * the TUI also calls `refreshCapabilities`, which used to mean two identical
     * probe bursts six requests each.
     */
    async function refresh(reason: string, force = false): Promise<void> {
      if (refreshing) return refreshing
      refreshing = doRefresh(reason, force).finally(() => {
        refreshing = undefined
      })
      return refreshing
    }

    async function doRefresh(reason: string, force: boolean): Promise<void> {
      await syncEndpoint()
      if (!normalizedEndpoint) {
        client = undefined
        capabilities = undefined
        credentialPresent = false
        return
      }

      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      const credential = connection ? await ctx.integration.connection.resolve(connection) : undefined
      const token = credential?.type === "key" ? credential.key : undefined
      credentialPresent = typeof token === "string" && token !== ""

      if (!credentialPresent || token === undefined) {
        client = undefined
        capabilities = undefined
        return
      }

      // The client is always rebuilt: skipping it would leave the instance
      // looking unconfigured and hide every tool behind the `read` gate.
      client = new CoolifyClient({
        endpoint: normalizedEndpoint,
        token,
        onDenied: ({ capability, method, path }) => downgrade(capability, method, path),
      })

      // A recent report is still true unless the token just changed, which is
      // what `force` marks. Only the probe is skipped, never the client.
      if (!force && capabilities && Date.now() - capabilities.checkedAt < CAPABILITY_TTL_MS) return

      try {
        capabilities = await probeCapabilities(client)
        await writeCapabilities(store, capabilities)
      } catch (error) {
        console.error(`[coolify] capability probe failed during ${reason}: ${describeError(error)}`)
        capabilities = undefined
      }
    }

    /** Learn from a real 403: record the missing ability and rebuild tools. */
    function downgrade(capability: Capability, method: string, path: string): void {
      if (!capabilities) return
      if (capabilities.probes[capability].status === "denied") return
      capabilities = {
        ...capabilities,
        likelyRoot: false,
        probes: {
          ...capabilities.probes,
          [capability]: { status: "denied", detail: `${method} ${path} returned 403` },
        },
      }
      void writeCapabilities(store, capabilities)
      void ctx.tool.reload()
      emitCapabilities()
    }

    function capabilitiesPayload(): CapabilitiesPayload {
      if (!normalizedEndpoint) {
        return {
          connected: false,
          endpointConfigured: false,
          message:
            "No Coolify endpoint is configured. Run `/coolify instance` to set one, or set the `COOLIFY_ENDPOINT` environment variable.",
        }
      }
      if (!capabilities) {
        return {
          connected: false,
          endpoint: normalizedEndpoint,
          endpointConfigured: true,
          message: credentialPresent
            ? "The API token could not be probed. Check that API access is enabled on the instance."
            : "No Coolify API token is connected. Run `/coolify token`.",
        }
      }
      return {
        connected: true,
        endpoint: capabilities.endpoint,
        endpointConfigured: true,
        ...(capabilities.team ? { team: capabilities.team } : {}),
        probes: capabilities.probes,
        likelyRoot: capabilities.likelyRoot,
        checkedAt: capabilities.checkedAt,
        notes: capabilities.notes,
      }
    }

    /**
     * The panel's data source: the applications this repository maps, each with
     * its live container state, or every application in the project.
     *
     * Wrapped in a short-lived cache keyed by endpoint, scope and directory, so
     * several sessions polling the same project share one fan-out instead of
     * each paying for it. A `fresh` request — an event-driven or manual refresh —
     * always rebuilds, because the point of those is to observe a change the
     * cache would otherwise hide.
     */
    async function applicationsPayload(
      scope: string | undefined,
      directory?: string,
      fresh = false,
    ): Promise<ApplicationsPayload> {
      const mode: "mapped" | "project" = scope === "project" ? "project" : "mapped"
      await syncEndpoint()
      // An endpoint that appeared since this instance started has no client yet,
      // so build one before deciding the plugin is unconfigured.
      if (!client && normalizedEndpoint) await refresh("applications")
      if (!client) return { scope: mode, refreshSeconds, apps: [], ...capabilitiesPayload() }

      // The RPC `location` option is not honoured, so the caller states which
      // project directory it means. Without it the server would answer for its
      // own default location, which is how the sidebar missed a fresh mapping.
      // No fallback to `ctx.location.directory`: the RPC may be routed to a
      // different location's plugin instance, so guessing answers for the wrong
      // project. The caller must say which directory it means.
      const base = nonEmpty(directory)
      if (!base) {
        return {
          scope: mode,
          apps: [],
          ...capabilitiesPayload(),
          message: "No project directory was supplied, so the sidebar cannot know which project to show.",
        }
      }

      // The directory is part of the key because it decides which `coolify.json`
      // applies: a worktree must never be answered with its main checkout's
      // state. The scope and recursion flag change the payload's shape, and the
      // endpoint changes which instance it describes.
      const key = [client.endpoint, mode, recursiveProjects ? "recursive" : "flat", base].join("\n")
      const cached = applicationsCache.get(key)
      if (cached) {
        const age = Date.now() - cached.at
        if (age < FRESH_COALESCE_MS || (!fresh && age < refreshSeconds * 1_000)) return cached.payload
      }
      // Concurrent callers — several sidebars reacting to the same event — wait
      // on the build already running rather than starting another fan-out.
      const inFlight = applicationsInFlight.get(key)
      if (inFlight) return inFlight

      const build = buildApplicationsPayload(mode, base)
        .then((payload) => {
          applicationsCache.set(key, { at: Date.now(), payload })
          return payload
        })
        .finally(() => {
          applicationsInFlight.delete(key)
        })
      applicationsInFlight.set(key, build)
      return build
    }

    /** Build a fresh payload from Coolify. The caching wrapper above calls this. */
    async function buildApplicationsPayload(
      mode: "mapped" | "project",
      base: string,
    ): Promise<ApplicationsPayload> {
      // The wrapper only reaches here with a client in hand; capture it so the
      // body below can stay free of non-null assertions.
      const coolify = client
      if (!coolify) throw new Error("applications payload built without a Coolify client")
      const config = await findProjectConfig(base)
      const apps: AppStatusPayload[] = []

      // Fetched at most once per payload, and only if a row actually needs it.
      let queuePromise: Promise<readonly CoolifyDeployment[]> | undefined
      const queueOnce = () => (queuePromise ??= listDeployments(coolify, undefined).catch(() => []))

      /**
       * The project's environments, read at most once per payload. The same list
       * backs application grouping, database attribution and the environment
       * inventory the sidebar labels rows with. Empty when the project is
       * unknown or the call fails, in which case rows simply stay ungrouped.
       */
      const environmentCache = new Map<string, Promise<readonly CoolifyEnvironment[]>>()
      const projectEnvironments = (projectUUID: string): Promise<readonly CoolifyEnvironment[]> => {
        const cached = environmentCache.get(projectUUID)
        if (cached) return cached
        const promise = listEnvironments(coolify, projectUUID).catch(() => [] as CoolifyEnvironment[])
        environmentCache.set(projectUUID, promise)
        return promise
      }

      /** The environment names, de-duplicated and kept in Coolify's order. */
      const projectEnvironmentNames = async (projectUUID: string | undefined): Promise<string[]> => {
        if (!projectUUID) return []
        const names: string[] = []
        for (const environment of await projectEnvironments(projectUUID)) {
          const name = environment.name ?? environment.uuid
          if (name && !names.includes(name)) names.push(name)
        }
        return names
      }

      /** An `environment_id` → name map, so a database can be attributed. */
      const projectEnvironmentNamesByID = async (
        projectUUID: string | undefined,
      ): Promise<Map<string, string>> => {
        const map = new Map<string, string>()
        if (!projectUUID) return map
        for (const environment of await projectEnvironments(projectUUID)) {
          if (environment.id === undefined) continue
          const name = environment.name ?? environment.uuid
          if (name) map.set(String(environment.id), name)
        }
        return map
      }

      /**
       * Which Coolify environment each application belongs to.
       *
       * `GET /applications/:uuid` does not report the environment, so it is
       * read from the project's environments instead. Empty when the project
       * is unknown or the calls fail, in which case rows simply stay ungrouped.
       */
      let environmentByApplication: ReadonlyMap<string, string> | undefined
      const mapEnvironments = async (projectUUID: string): Promise<Map<string, string>> => {
        const map = new Map<string, string>()
        for (const environment of await projectEnvironments(projectUUID)) {
          const name = environment.name ?? environment.uuid
          if (!name) continue
          const detail = await coolify
            .request<{ applications?: readonly { uuid?: string }[] }>({
              method: "GET",
              path: `/projects/${projectUUID}/${environment.uuid ?? environment.name}`,
              requires: "read",
            })
            .catch(() => undefined)
          for (const application of detail?.applications ?? []) {
            if (application.uuid && !map.has(application.uuid)) map.set(application.uuid, name)
          }
        }
        return map
      }

      const describe = async (
        into: AppStatusPayload[],
        key: string,
        applicationUUID: string,
        path: string | undefined,
        isSelected: boolean,
      ): Promise<void> => {
        const application = await getApplication(coolify, applicationUUID).catch(() => undefined)
        const latest = await latestDeploymentFor(coolify, applicationUUID, undefined, queueOnce).catch(
          () => undefined,
        )
        const environment = environmentByApplication?.get(applicationUUID) ?? application?.environment_name
        into.push({
          key,
          applicationUUID,
          name: application?.name ?? key,
          ...(path ? { path } : {}),
          ...(application?.fqdn ? { domains: application.fqdn } : {}),
          ...(environment ? { environment } : {}),
          runtime: parseApplicationStatus(application?.status),
          ...(latest
            ? {
                latestDeployment: {
                  ...(typeof latest.status === "string" ? { status: latest.status } : {}),
                  ...(typeof latest.commit === "string" ? { commit: latest.commit } : {}),
                },
              }
            : {}),
          ...(isSelected ? { selected: true } : {}),
        })
      }

      /**
       * Enrich one config's applications, in map order. The linked application
       * is a fallback only for the config that owns the working directory, so it
       * is not repeated once per section.
       */
      const buildRows = async (
        projectConfig: ProjectConfig | undefined,
        allowLinkFallback: boolean,
      ): Promise<AppStatusPayload[]> => {
        const rows: AppStatusPayload[] = []
        const selected = projectConfig ? selectApplication(projectConfig, base) : undefined
        const entries = Object.entries(projectConfig?.applications ?? {}).slice(0, 12)
        if (entries.length > 0) {
          await Promise.all(
            entries.map(([key, entry]) =>
              describe(rows, key, entry.applicationUUID, entry.path, selected?.key === key),
            ),
          )
        } else if (allowLinkFallback && link) {
          await describe(rows, link.name ?? "application", link.applicationUUID, undefined, true)
        }
        return rows
      }

      /**
       * Databases the config maps, plus the databases the project owns.
       *
       * The config's `databases` map gives a stable key, a display name and a
       * path scope, but the API exposes no project relation at all, so a
       * database created in the Coolify UI is invisible to the sidebar through
       * the config alone. `GET /databases` does carry `environment_id`, so the
       * project's environment ids are used to discover the rest. Both sources
       * are merged and de-duplicated by UUID; discovery is skipped silently
       * when the environments (or their ids) cannot be read.
       */
      let databaseListPromise: Promise<readonly CoolifyDatabase[]> | undefined
      const databaseListOnce = (): Promise<readonly CoolifyDatabase[]> =>
        (databaseListPromise ??= listDatabases(coolify).catch(() => [] as CoolifyDatabase[]))

      const databaseRow = async (
        key: string,
        entry: ProjectConfigDatabase,
        environmentNames: ReadonlyMap<string, string>,
      ): Promise<DatabaseStatusPayload> => {
        let uuid = entry.databaseUUID
        if (!uuid) {
          const wanted = (entry.name ?? key).trim().toLowerCase()
          const match = (await databaseListOnce()).find(
            (candidate) => (candidate.name ?? "").trim().toLowerCase() === wanted,
          )
          uuid = match?.uuid
        }
        const database = uuid ? await getDatabase(coolify, uuid).catch(() => undefined) : undefined
        const type = database?.type ?? entry.type
        const environment =
          database?.environment_name ??
          (database?.environment_id === undefined
            ? undefined
            : environmentNames.get(String(database.environment_id)))
        return {
          key,
          ...(uuid ? { databaseUUID: uuid } : {}),
          name: database?.name ?? entry.name ?? key,
          ...(type ? { type } : {}),
          ...(entry.path ? { path: entry.path } : {}),
          ...(environment ? { environment } : {}),
          ...(database ? { runtime: databaseRuntime(database) } : {}),
        }
      }

      const buildDatabaseRows = async (
        projectConfig: ProjectConfig | undefined,
        projectUUID: string | undefined,
      ): Promise<DatabaseStatusPayload[]> => {
        const rows: DatabaseStatusPayload[] = []
        const covered = new Set<string>()
        const environmentNames = await projectEnvironmentNamesByID(projectUUID)

        // Config-mapped first, so their key, name and path win.
        const entries = projectConfig ? Object.entries(databasesFor(projectConfig, base)).slice(0, 12) : []
        const mapped = await Promise.all(
          entries.map(([key, entry]) => databaseRow(key, entry, environmentNames)),
        )
        for (const row of mapped) {
          rows.push(row)
          if (row.databaseUUID) covered.add(row.databaseUUID)
        }

        // Then anything else the project owns.
        if (environmentNames.size > 0) {
          for (const database of await databaseListOnce()) {
            const environmentID = database.environment_id === undefined ? undefined : String(database.environment_id)
            if (!environmentID || !environmentNames.has(environmentID)) continue
            if (!database.uuid || covered.has(database.uuid)) continue
            covered.add(database.uuid)
            const environment = database.environment_name ?? environmentNames.get(environmentID)
            rows.push({
              key: databaseSlug(database.name ?? database.uuid),
              databaseUUID: database.uuid,
              name: database.name ?? database.uuid,
              ...(database.type ? { type: database.type } : {}),
              ...(environment ? { environment } : {}),
              runtime: databaseRuntime(database),
            })
          }
        }

        return rows
      }

      const projectUUID = config?.projectUUID ?? link?.projectUUID
      if (projectUUID) environmentByApplication = await mapEnvironments(projectUUID)
      let projects: ApplicationsProjectPayload[] | undefined
      let configFile = config?.file
      let databases: DatabaseStatusPayload[] = []
      let environments: readonly string[] = []
      if (mode === "project" && projectUUID) {
        // Applications do not report a usable `project_uuid`, so the project is
        // read through its environments instead. Filtering the flat
        // `/applications` list by project silently returned nothing.
        const projectEnvironmentList = await projectEnvironments(projectUUID)
        environments = await projectEnvironmentNames(projectUUID)
        const members: { uuid: string; name: string }[] = []
        for (const environment of projectEnvironmentList) {
          const detail = await coolify
            .request<{ applications?: readonly { uuid?: string; name?: string }[] }>({
              method: "GET",
              path: `/projects/${projectUUID}/${environment.uuid ?? environment.name}`,
              requires: "read",
            })
            .catch(() => undefined)
          for (const application of detail?.applications ?? []) {
            if (application.uuid && !members.some((member) => member.uuid === application.uuid)) {
              members.push({ uuid: application.uuid, name: application.name ?? application.uuid })
            }
          }
        }
        await Promise.all(
          members.slice(0, 20).map((member) => describe(apps, member.name, member.uuid, undefined, false)),
        )
        databases = await buildDatabaseRows(config, projectUUID)
      } else if (recursiveProjects) {
        // Opt-in: a repository can hold several configs, so discover them all
        // from the repository root and render one section per group.
        const root = await findRepositoryRoot(base)
        const configs = await findAllProjectConfigs(root)
        // `findProjectConfig` is nearest-wins; when the owning config sits
        // deeper than the walk bound it must still be shown.
        if (config && !configs.some((entry) => entry.file === config.file)) configs.unshift(config)
        projects = await Promise.all(
          configs.map(async (projectConfig) => {
            const environmentNames = await projectEnvironmentNames(projectConfig.projectUUID)
            return {
              file: projectConfig.file,
              relativeFile: relativePath(root, projectConfig.file).split("\\").join("/"),
              ...(projectConfig.projectUUID === undefined ? {} : { projectUUID: projectConfig.projectUUID }),
              ...(projectConfig.environmentName === undefined
                ? {}
                : { environmentName: projectConfig.environmentName }),
              ...(environmentNames.length > 0 ? { environments: environmentNames } : {}),
              configFile: projectConfig.file,
              apps: await buildRows(projectConfig, projectConfig.file === config?.file),
              databases: await buildDatabaseRows(projectConfig, projectConfig.projectUUID),
            }
          }),
        )
        const selectedProject = projects.find((entry) => entry.file === config?.file) ?? projects[0]
        if (selectedProject) {
          configFile = selectedProject.file
          apps.push(...selectedProject.apps)
          databases = [...selectedProject.databases]
          environments = selectedProject.environments ?? []
        } else {
          // No config anywhere: keep the pinned-application fallback.
          apps.push(...(await buildRows(config, true)))
          databases = await buildDatabaseRows(config, projectUUID)
          environments = await projectEnvironmentNames(projectUUID)
        }
      } else {
        apps.push(...(await buildRows(config, true)))
        databases = await buildDatabaseRows(config, projectUUID)
        environments = await projectEnvironmentNames(projectUUID)
      }

      return {
        connected: true,
        endpoint: coolify.endpoint,
        endpointConfigured: true,
        ...(projectUUID ? { projectUUID } : {}),
        ...(config?.environmentName ? { environmentName: config.environmentName } : {}),
        ...(configFile ? { configFile } : {}),
        ...(environments.length > 0 ? { environments } : {}),
        scope: mode,
        refreshSeconds,
        recursiveProjects,
        apps,
        databases,
        ...(projects && projects.length > 0 ? { projects } : {}),
        capabilities: capabilitiesPayload(),
      }
    }

    /**
     * Write `coolify.json` for a directory. This is the path the TUI uses to
     * map a project deterministically, without spending a model turn.
     */
    async function configureProjectPayload(input: Record<string, unknown> | undefined) {
      const directory = nonEmpty(input?.directory) ?? ctx.location.directory
      const file = await configFileFor(directory)
      if (!file) {
        return {
          ok: false,
          file: "",
          applications: 0,
          databases: 0,
          message: "This directory is not inside a git repository, so there is nowhere to write coolify.json.",
        }
      }

      const update: Parameters<typeof updateProjectConfig>[1] = {
        ...(nonEmpty(input?.projectUUID) ? { projectUUID: nonEmpty(input?.projectUUID)! } : {}),
        ...(nonEmpty(input?.environmentName) ? { environmentName: nonEmpty(input?.environmentName)! } : {}),
        ...(nonEmpty(input?.serverUUID) ? { serverUUID: nonEmpty(input?.serverUUID)! } : {}),
        ...(nonEmpty(input?.applicationUUID) ? { applicationUUID: nonEmpty(input?.applicationUUID)! } : {}),
        ...(asApplicationMap(input?.applications) ? { applications: asApplicationMap(input?.applications)! } : {}),
        ...(asDatabaseMap(input?.databases) ? { databases: asDatabaseMap(input?.databases)! } : {}),
      }

      const config = await updateProjectConfig(file, update)
      emitProjectChanged(file)
      return {
        ok: true,
        file,
        applications: Object.keys(config.applications).length,
        databases: Object.keys(config.databases).length,
      }
    }

    /**
     * Write a `coolify.json` verbatim. This is the fallback for when the
     * model-driven mapping produced a file but could not apply it — the user
     * pastes what the model generated and the plugin writes it unchanged.
     */
    async function writeProjectJsonPayload(input: Record<string, unknown> | undefined) {
      const directory = nonEmpty(input?.directory) ?? ctx.location.directory
      const raw = typeof input?.content === "string" ? input.content : ""
      if (raw.trim() === "") return { ok: false, file: "", message: "The config is empty." }

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (cause) {
        return { ok: false, file: "", message: `That is not valid JSON: ${describeError(cause)}` }
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, file: "", message: "coolify.json must be a JSON object." }
      }

      const problem = validateProjectJson(parsed as Record<string, unknown>)
      if (problem) return { ok: false, file: "", message: problem }

      const file = await configFileFor(directory)
      if (!file) {
        return {
          ok: false,
          file: "",
          message: "This directory is not inside a git repository, so there is nowhere to write coolify.json.",
        }
      }

      // Rewritten through `JSON.stringify` so the formatting matches the
      // structured writer above; two writers producing different indentation
      // would make every later diff noisy.
      await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
      emitProjectChanged(file)
      return { ok: true, file, message: `Wrote ${file}.` }
    }

    function emitProjectChanged(file: string): void {
      // The mapping on disk changed, so every cached payload that read it is
      // stale regardless of its age.
      invalidateApplications()
      void rpc.events.emit("project.changed", { file })
    }

    async function statusPayload(override?: string) {      const resolution = await resolveProject({
        store,
        projectID,
        directory: ctx.location.directory,
        client,
        capabilities,
      })

      // Without a client the pin or config file can still name the application.
      if (!client) {
        return {
          ...capabilitiesPayload(),
          linked: override !== undefined || resolution.link !== undefined,
          resolution,
        }
      }

      const target = override ?? link?.applicationUUID ?? resolution.best?.applicationUUID
      if (!target) {
        return {
          connected: true,
          endpoint: client.endpoint,
          linked: false,
          resolution,
          message: resolution.notes.join(" "),
        }
      }

      const application = await getApplication(client, target).catch(() => undefined)
      const history = await listApplicationDeployments(client, target, { take: 1 }).catch(() => [])
      return {
        connected: true,
        endpoint: client.endpoint,
        endpointConfigured: true,
        linked: true,
        resolution,
        ...(application
          ? {
              application: {
                uuid: application.uuid,
                name: application.name,
                fqdn: application.fqdn ?? null,
                ...(typeof application.status === "string" ? { status: application.status } : {}),
                runtime: parseApplicationStatus(application.status),
              },
            }
          : {}),
        ...(Array.isArray(history) && history[0] ? { latestDeployment: history[0] as Record<string, unknown> } : {}),
        capabilities: capabilitiesPayload(),
      }
    }

    async function resolveTarget(explicit?: string): Promise<string | undefined> {
      if (explicit) return explicit
      const resolution = await resolveProject({
        store,
        projectID,
        directory: ctx.location.directory,
        client,
        capabilities,
      })
      const target = link?.applicationUUID ?? resolution.best?.applicationUUID
      if (!link && resolution.best && resolution.source === "discovered") {
        await writeLink(store, projectID, linkFromCandidate(resolution.best))
        link = await readLink(store, projectID)
      }
      return target
    }

    async function setLink(next: ResolvedLink | undefined): Promise<void> {
      link = next
      invalidateApplications()
      if (next) await writeLink(store, projectID, next)
      else await clearLink(store, projectID)
      await ctx.tool.reload()
    }

    function linkFromCandidate(candidate: { applicationUUID: string; name?: string; gitRepository?: string; projectUUID?: string; environmentName?: string; serverUUID?: string }): ResolvedLink {
      return {
        applicationUUID: candidate.applicationUUID,
        ...(candidate.name ? { name: candidate.name } : {}),
        ...(candidate.gitRepository ? { gitRepository: candidate.gitRepository } : {}),
        ...(candidate.projectUUID ? { projectUUID: candidate.projectUUID } : {}),
        ...(candidate.environmentName ? { environmentName: candidate.environmentName } : {}),
        ...(candidate.serverUUID ? { serverUUID: candidate.serverUUID } : {}),
        linkedAt: Date.now(),
        source: "git-remote",
      }
    }
  },
})

function readEndpoint(options: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["endpoint", "url", "baseUrl"]) {
    const value = options[key]
    if (typeof value === "string" && value.trim() !== "") return value.trim()
  }
  // Global installs (the discovery layout) cannot carry options, so allow the
  // environment to supply the endpoint instead.
  const fromEnv = process.env.COOLIFY_ENDPOINT
  return typeof fromEnv === "string" && fromEnv.trim() !== "" ? fromEnv.trim() : undefined
}

function normalizeOrUndefined(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    return normalizeEndpoint(raw)
  } catch {
    return undefined
  }
}

function optionalString<Key extends string>(key: Key, value: unknown): Record<Key, string> | Record<string, never> {
  return typeof value === "string" && value !== "" ? ({ [key]: value } as Record<Key, string>) : {}
}

/** A stable key for a discovered database, in the config map's style. */
function databaseSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug === "" ? "database" : slug
}
