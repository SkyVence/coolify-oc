import { Integration, Plugin } from "@opencode/plugin"
import { relative as relativePath } from "node:path"
import { probeCapabilities } from "./coolify/capabilities"
import { CoolifyClient, normalizeEndpoint } from "./coolify/client"
import {
  cancelDeployment,
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
import {
  describeError,
  granted,
  type Capability,
  type CapabilityReport,
  type CoolifyDeployment,
} from "./coolify/types"
import { parseApplicationStatus } from "./coolify/runtime"
import { parseRefreshSeconds } from "./options"
import {
  findAllProjectConfigs,
  findProjectConfig,
  findRepositoryRoot,
  selectApplication,
  updateProjectConfig,
  type ProjectConfig,
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
} from "./rpc"
import { resolveProject } from "./resolve"
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

    // --- RPC ----------------------------------------------------------------
    const rpc = await ctx.rpc.register(CoolifyRpc, {
      capabilities: async () => capabilitiesPayload(),

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
        await refresh("setEndpoint")
        await ctx.tool.reload()
        emitCapabilities()
        return { ok: true, endpoint: normalized }
      },

      resolve: async (input) => {
        const payload = input as { autoLink?: boolean; directory?: string } | undefined
        const directory = nonEmpty(payload?.directory) ?? ctx.location.directory
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
        const payload = input as { scope?: string; directory?: string } | undefined
        return applicationsPayload(payload?.scope, payload?.directory)
      },

      configureProject: async (input) => configureProjectPayload(input as Record<string, unknown> | undefined),

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
            "No Coolify endpoint is configured. Run `/coolify-connect` to set one, or set the `COOLIFY_ENDPOINT` environment variable.",
        }
      }
      if (!capabilities) {
        return {
          connected: false,
          endpoint: normalizedEndpoint,
          endpointConfigured: true,
          message: credentialPresent
            ? "The API token could not be probed. Check that API access is enabled on the instance."
            : "No Coolify API token is connected. Run `/coolify-connect`.",
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
     */
    async function applicationsPayload(scope: string | undefined, directory?: string): Promise<ApplicationsPayload> {
      const mode: "mapped" | "project" = scope === "project" ? "project" : "mapped"
      if (!client) return { scope: mode, refreshSeconds, apps: [], ...capabilitiesPayload() }

      // The RPC `location` option is not honoured, so the caller states which
      // project directory it means. Without it the server would answer for its
      // own default location, which is how the sidebar missed a fresh mapping.
      const base = directory && directory !== "" ? directory : ctx.location.directory
      const config = await findProjectConfig(base)
      const apps: AppStatusPayload[] = []

      // Fetched at most once per payload, and only if a row actually needs it.
      let queuePromise: Promise<readonly CoolifyDeployment[]> | undefined
      const queueOnce = () => (queuePromise ??= listDeployments(client!, undefined).catch(() => []))

      const describe = async (
        into: AppStatusPayload[],
        key: string,
        applicationUUID: string,
        path: string | undefined,
        isSelected: boolean,
      ): Promise<void> => {
        const application = await getApplication(client!, applicationUUID).catch(() => undefined)
        const latest = await latestDeploymentFor(client!, applicationUUID, undefined, queueOnce).catch(
          () => undefined,
        )
        into.push({
          key,
          applicationUUID,
          name: application?.name ?? key,
          ...(path ? { path } : {}),
          ...(application?.fqdn ? { domains: application.fqdn } : {}),
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

      const projectUUID = config?.projectUUID ?? link?.projectUUID
      let projects: ApplicationsProjectPayload[] | undefined
      let configFile = config?.file
      if (mode === "project" && projectUUID) {
        // Applications do not report a usable `project_uuid`, so the project is
        // read through its environments instead. Filtering the flat
        // `/applications` list by project silently returned nothing.
        const environments = await listEnvironments(client, projectUUID).catch(() => [])
        const members: { uuid: string; name: string }[] = []
        for (const environment of environments) {
          const detail = await client!
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
      } else if (directory && directory !== "") {
        // A repository can hold several configs. The caller named a directory,
        // so discover them all from the repository root and render each group.
        const root = await findRepositoryRoot(base)
        const configs = await findAllProjectConfigs(root)
        // `findProjectConfig` is nearest-wins; when the owning config sits
        // deeper than the walk bound it must still be shown.
        if (config && !configs.some((entry) => entry.file === config.file)) configs.unshift(config)
        projects = await Promise.all(
          configs.map(async (projectConfig) => ({
            file: projectConfig.file,
            relativeFile: relativePath(root, projectConfig.file).split("\\").join("/"),
            ...(projectConfig.projectUUID === undefined ? {} : { projectUUID: projectConfig.projectUUID }),
            ...(projectConfig.environmentName === undefined
              ? {}
              : { environmentName: projectConfig.environmentName }),
            configFile: projectConfig.file,
            apps: await buildRows(projectConfig, projectConfig.file === config?.file),
          })),
        )
        const selectedProject = projects.find((entry) => entry.file === config?.file) ?? projects[0]
        if (selectedProject) {
          configFile = selectedProject.file
          apps.push(...selectedProject.apps)
        } else {
          // No config anywhere: keep the pinned-application fallback.
          apps.push(...(await buildRows(config, true)))
        }
      } else {
        apps.push(...(await buildRows(config, true)))
      }

      return {
        connected: true,
        endpoint: client.endpoint,
        endpointConfigured: true,
        ...(projectUUID ? { projectUUID } : {}),
        ...(config?.environmentName ? { environmentName: config.environmentName } : {}),
        ...(configFile ? { configFile } : {}),
        scope: mode,
        refreshSeconds,
        apps,
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

    function emitProjectChanged(file: string): void {
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
