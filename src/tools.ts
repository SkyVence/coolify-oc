import type { ToolContext } from "@opencode/plugin/promise/tool"

export type { ToolDeps, ToolResult, ToolSpec, ToolTier } from "./tools/shared"
import { join } from "node:path"
import type { CoolifyClient } from "./coolify/client"
import {
  DATABASE_TYPES,
  createDatabase,
  databaseRuntime,
  isDatabaseType,
  listDatabases,
  type DatabaseType,
} from "./coolify/databases"
import {
  cancelDeployment,
  getDeployment,
  listApplicationDeployments,
  listDeployments,
  normalizeDeploymentStatus,
  triggerDeploy,
  waitForDeployment,
} from "./coolify/deploy"
import {
  getApplication,
  listApplications,
  listDestinations,
  listEnvironments,
  listProjects,
  listServers,
  restartApplication,
  rollbackApplication,
  startApplication,
  stopApplication,
  updateApplication,
} from "./coolify/resources"
import {
  granted,
  type Capability,
  type CapabilityReport,
  type CoolifyApplication,
  type CoolifyDeployment,
} from "./coolify/types"
import { parseApplicationStatus } from "./coolify/runtime"
import { linkCandidate, resolveProject, type Resolution } from "./resolve"
import { findProjectConfig, updateProjectConfig, type ProjectConfigUpdate } from "./project-config"
import { readLink, type ResolvedLink, type StorageLike } from "./store"


/**
 * Fields the model may change through `coolify_update_settings`.
 *
 * This is the `PATCH /applications/{uuid}` body contract. Keeping it as an
 * explicit allow-list means an unknown or misspelled key fails locally with a
 * useful message instead of being sent to Coolify.
 */
import { APPLICATION_SETTING_FIELDS, SETTING_FIELD_SET } from "./tools/settings-fields"
import { applicationTool, applicationUpdateTool, envValueTool } from "./tools/application"
import { databaseManageTool, databaseTool } from "./tools/database"
import { createApplicationTool, planApplicationTool } from "./tools/create"
import { destroyTool, projectManageTool, projectTool } from "./tools/infra"
import {
  MISSING_CREDENTIAL,
  MISSING_ENDPOINT,
  WITH_ENDPOINT,
  asApplicationMap,
  asDatabaseMap,
  fetchApplication,
  formatResolution,
  latestDeploymentFor,
  nonEmpty,
  optionalString,
  requireString,
  resolutionOf,
  resolvePlacement,
  resolveTarget,
  type ToolDeps,
  type ToolResult,
  type ToolSpec,
  type ToolTier,
} from "./tools/shared"


export function buildTools(deps: ToolDeps): ToolSpec[] {
  const capabilities = deps.getCapabilities()
  const can = (capability: Capability): boolean => granted(capabilities, capability)
  const connected = deps.getClient() !== undefined

  const tools: ToolSpec[] = [
    capabilitiesTool(deps),
    configureProjectTool(deps),
    resolveTool(deps),
    linkTool(deps),
    unlinkTool(deps),
  ]

  if (connected && can("read")) {
    tools.push(
      statusTool(deps),
      listResourcesTool(deps),
      deploymentStatusTool(deps),
      databasesTool(deps),
      applicationTool(deps),
      databaseTool(deps),
      projectTool(deps),
      planApplicationTool(deps),
      // Reading a value needs read access to list envs; the tier is what makes
      // this tool separately deniable.
      envValueTool(deps),
    )
  }
  if (connected && can("write")) {
    tools.push(
      applicationUpdateTool(deps),
      createDatabaseTool(deps),
      databaseManageTool(deps),
      projectManageTool(deps),
      createApplicationTool(deps),
    )
  }
  if (connected && can("deploy")) {
    tools.push(deployTool(deps))
  }
  if (connected) {
    // Deletion needs write; the tier, not the ability, is what gates intent.
    if (can("write")) tools.push(destroyTool(deps))
  }

  return tools
}

// ---------------------------------------------------------------------------
// Always available (no Coolify access required)
// ---------------------------------------------------------------------------

function capabilitiesTool(deps: ToolDeps): ToolSpec {
  return {
    name: "capabilities",
    tier: "read",
    description:
      "Report which Coolify abilities the connected API token has. Call this first when a Coolify operation fails or before promising a change, because a deploy-only token cannot read projects and a read token cannot change settings.",
    input: { type: "object", properties: {}, additionalProperties: false },
    async run(): Promise<ToolResult> {
      const report = deps.getCapabilities()
      if (!deps.endpoint) return { content: MISSING_ENDPOINT, metadata: { configured: false } }
      if (!report) return { content: MISSING_CREDENTIAL, metadata: { configured: true, connected: false } }

      const lines = [
        `Endpoint: ${report.endpoint}`,
        report.team ? `Team: ${report.team.name ?? report.team.id ?? "unknown"}` : "Team: unknown",
        "",
        "Abilities:",
        ...(["read", "read:sensitive", "write", "deploy"] as const).map(
          (capability) => `- ${capability}: ${report.probes[capability].status} — ${report.probes[capability].detail}`,
        ),
        "",
        report.likelyRoot
          ? "Every probed ability passed, which is consistent with a root token."
          : "This is not a root token, or not all abilities could be probed.",
      ]
      if (report.notes.length > 0) lines.push("", ...report.notes.map((note) => `- ${note}`))

      return {
        content: lines.join("\n"),
        metadata: {
          endpoint: report.endpoint,
          likelyRoot: report.likelyRoot,
          probes: report.probes,
        },
      }
    },
  }
}

function resolveTool(deps: ToolDeps): ToolSpec {
  return {
    name: "resolve",
    tier: "read",
    description:
      "Find the Coolify application that already deploys this project, checking the pinned link, a .coolify.json in the repository, then matching the git remote and directory name against Coolify. Set autoLink to persist an unambiguous match.",
    input: {
      type: "object",
      properties: {
        autoLink: {
          type: "boolean",
          description: "Persist the best match as this project's linked application when it is unambiguous.",
        },
      },
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const resolution = await resolveProject({
        store: deps.store,
        projectID: deps.projectID,
        directory: deps.directory,
        client: deps.getClient(),
        capabilities: deps.getCapabilities(),
        signal: context.signal,
      })

      let linked: ResolvedLink | undefined = resolution.link
      if (input?.autoLink === true && resolution.source === "discovered" && resolution.best) {
        const application = await fetchApplication(deps, resolution.best.applicationUUID, context.signal)
        linked = application
          ? linkCandidate(application, "git-remote")
          : {
              applicationUUID: resolution.best.applicationUUID,
              ...(resolution.best.name ? { name: resolution.best.name } : {}),
              ...(resolution.best.gitRepository ? { gitRepository: resolution.best.gitRepository } : {}),
              ...(resolution.best.projectUUID ? { projectUUID: resolution.best.projectUUID } : {}),
              ...(resolution.best.environmentName ? { environmentName: resolution.best.environmentName } : {}),
              ...(resolution.best.serverUUID ? { serverUUID: resolution.best.serverUUID } : {}),
              linkedAt: Date.now(),
              source: "git-remote",
            }
        await deps.setLink(linked)
      }

      return {
        content: formatResolution(resolution, linked),
        metadata: { source: resolution.source, ambiguous: resolution.ambiguous, linked: linked !== undefined },
      }
    },
  }
}

function linkTool(deps: ToolDeps): ToolSpec {
  return {
    name: "link",
    tier: "write",
    description:
      "Pin a Coolify application to this project so future calls resolve it automatically. Use this when the user names an application or when resolution is ambiguous.",
    input: {
      type: "object",
      properties: {
        applicationUUID: { type: "string", description: "The Coolify application UUID." },
        projectUUID: { type: "string" },
        environmentName: { type: "string" },
        serverUUID: { type: "string" },
        name: { type: "string" },
        gitRepository: { type: "string" },
      },
      required: ["applicationUUID"],
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const applicationUUID = requireString(input, "applicationUUID")
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(applicationUUID)) {
        return { content: `"${applicationUUID}" does not look like a Coolify UUID.` }
      }

      // Prefer live data so the link carries project, environment, and server.
      const application = await fetchApplication(deps, applicationUUID, context.signal)
      const link: ResolvedLink = application
        ? linkCandidate(application, "pin")
        : {
            applicationUUID,
            ...optionalString("projectUUID", input?.projectUUID),
            ...optionalString("environmentName", input?.environmentName),
            ...optionalString("serverUUID", input?.serverUUID),
            ...optionalString("name", input?.name),
            ...optionalString("gitRepository", input?.gitRepository),
            linkedAt: Date.now(),
            source: "pin",
          }

      await deps.setLink(link)
      return {
        content: `Linked this project to Coolify application ${link.name ?? applicationUUID} (${applicationUUID}).`,
        metadata: { applicationUUID, verified: application !== undefined },
      }
    },
  }
}

function unlinkTool(deps: ToolDeps): ToolSpec {
  return {
    name: "unlink",
    tier: "write",
    description: "Forget the Coolify application pinned to this project. Does not delete anything on Coolify.",
    input: { type: "object", properties: {}, additionalProperties: false },
    async run(): Promise<ToolResult> {
      const existing = deps.getLink()
      await deps.setLink(undefined)
      return {
        content: existing
          ? `Unlinked Coolify application ${existing.name ?? existing.applicationUUID}.`
          : "This project was not linked to a Coolify application.",
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Read-gated
// ---------------------------------------------------------------------------

function statusTool(deps: ToolDeps): ToolSpec {
  return {
    name: "status",
    tier: "read",
    description:
      "Show the linked Coolify application and its most recent deployment, so you can tell whether the current commit is live.",
    input: {
      type: "object",
      properties: {
        applicationUUID: { type: "string", description: "Override the linked application for this call." },
      },
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      const target = await resolveTarget(deps, input?.applicationUUID, context.signal)
      if (!target) return { content: formatResolution(await resolutionOf(deps, context.signal)) }

      const [application, latest] = await Promise.all([
        getApplication(client, target, context.signal),
        latestDeploymentFor(client, target, context.signal),
      ])

      const lines = [
        `Application: ${application.name} (${application.uuid})`,
        `Domains: ${application.fqdn || "none"}`,
        `Repository: ${application.git_repository ?? "unknown"} @ ${application.git_branch ?? "unknown"}`,
        `Build pack: ${application.build_pack ?? "unknown"}`,
      ]
      const runtime = parseApplicationStatus(application.status)
      lines.push(
        runtime.state === "unknown" && runtime.health === "none"
          ? "Runtime: unknown (Coolify reported no container state)"
          : `Runtime: ${runtime.label}`,
      )
      if (latest) {
        const status = normalizeDeploymentStatus(latest.status)
        lines.push(
          `Latest deployment: ${status} (raw "${latest.status ?? "unknown"}")${
            latest.commit ? ` for ${latest.commit.slice(0, 7)}` : ""
          }`,
        )
      } else {
        lines.push("Latest deployment: none recorded")
      }

      return {
        content: lines.join("\n"),
        metadata: { applicationUUID: application.uuid, latestDeploymentStatus: latest?.status },
      }
    },
  }
}

function listResourcesTool(deps: ToolDeps): ToolSpec {
  return {
    name: "list_resources",
    tier: "read",
    description:
      "List Coolify projects, applications, servers, and destinations to discover UUIDs before linking or deploying.",
    input: {
      type: "object",
      properties: {
        include: {
          type: "array",
          items: { type: "string", enum: ["projects", "applications", "servers", "destinations"] },
        },
        projectUUID: { type: "string", description: "Also list the environments of this project." },
      },
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      const include: string[] = Array.isArray(input?.include)
        ? input.include
        : ["projects", "applications", "servers", "destinations"]
      const sections: string[] = []

      if (include.includes("applications")) {
        const applications = await listApplications(client, context.signal)
        sections.push(
          `Applications (${applications.length}):`,
          ...applications.map(
            (application) =>
              `- ${application.uuid}  ${application.name}  ${application.fqdn ?? ""}  ${
                application.git_repository ?? ""
              }`,
          ),
        )
      }
      if (include.includes("projects")) {
        const projects = await listProjects(client, context.signal)
        sections.push("", `Projects (${projects.length}):`, ...projects.map((project) => `- ${project.uuid}  ${project.name}`))
      }
      if (input?.projectUUID) {
        const environments = await listEnvironments(client, String(input.projectUUID), context.signal)
        sections.push(
          "",
          `Environments of ${input.projectUUID}:`,
          ...environments.map((environment) => `- ${environment.name}`),
        )
      }
      if (include.includes("servers")) {
        const servers = await listServers(client, context.signal)
        sections.push("", `Servers (${servers.length}):`, ...servers.map((server) => `- ${server.uuid}  ${server.name}`))
      }
      if (include.includes("destinations")) {
        const destinations = await listDestinations(client, context.signal)
        sections.push(
          "",
          `Destinations (${destinations.length}):`,
          ...destinations.map((destination) => `- ${destination.uuid}  ${destination.name ?? ""}`),
        )
      }

      return { content: sections.join("\n") }
    },
  }
}

function deploymentStatusTool(deps: ToolDeps): ToolSpec {
  return {
    name: "deployment_status",
    tier: "read",
    description: "Read one deployment by UUID, including its status and the tail of its log.",
    input: {
      type: "object",
      properties: { deploymentUUID: { type: "string" } },
      required: ["deploymentUUID"],
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }
      const deploymentUUID = requireString(input, "deploymentUUID")

      const deployment = await getDeployment(client, deploymentUUID, context.signal)
      const status = normalizeDeploymentStatus(deployment.status)
      const logTail = typeof deployment.logs === "string" ? deployment.logs.slice(-2_000) : ""

      return {
        content: [
          `Deployment ${deploymentUUID}: ${status} (raw "${deployment.status ?? "unknown"}")`,
          deployment.commit ? `Commit: ${deployment.commit}` : "",
          logTail ? `\nLog tail:\n${logTail}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        metadata: { status, raw: deployment.status, terminal: status !== "queued" && status !== "in_progress" },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Write-gated
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Deploy-gated
// ---------------------------------------------------------------------------

const DEPLOY_ACTIONS = ["deploy", "cancel", "rollback", "start", "stop", "restart"] as const

/**
 * Run and control deployments.
 *
 * Deploying waits by default so the model can report an outcome, but the
 * deployment UUID is always returned so it can poll instead. Lifecycle actions
 * resolve to a database when `databaseUUID` is given, otherwise to the linked
 * application.
 */
function deployTool(deps: ToolDeps): ToolSpec {
  return {
    name: "deploy",
    tier: "deploy",
    description: `Run and control deployments. Actions:
- deploy: trigger a deployment. Waits by default; pass wait:false to queue and poll with coolify_deployment_status.
- cancel: cancel a running deployment (deploymentUUID).
- rollback: redeploy a previous commit (commit).
- start / stop / restart: application lifecycle, or a database's when databaseUUID is given.`,
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...DEPLOY_ACTIONS] },
        applicationUUID: { type: "string", description: "Override the linked application." },
        databaseUUID: { type: "string", description: "Target a database for start/stop/restart." },
        deploymentUUID: { type: "string", description: "cancel: which deployment." },
        commit: { type: "string", description: "rollback: the commit to redeploy." },
        force: { type: "boolean", description: "deploy: rebuild without Docker build cache." },
        wait: { type: "boolean", description: "deploy: wait for a terminal status. Default true." },
        pr: { type: "integer", description: "deploy: a pull request preview build." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      const action = input?.action
      if (!DEPLOY_ACTIONS.includes(action)) {
        return { content: `Unknown action \`${action}\`. Choose one of: ${DEPLOY_ACTIONS.join(", ")}.` }
      }

      if (action === "cancel") {
        const deploymentUUID = requireString(input, "deploymentUUID")
        const result = await cancelDeployment(client, deploymentUUID, context.signal)
        return {
          content: result.message ?? `Requested cancellation of ${deploymentUUID} (status ${result.status ?? "unknown"}).`,
          metadata: { deploymentUUID, status: result.status },
        }
      }

      if (action === "start" || action === "stop" || action === "restart") {
        const databaseUUID = nonEmpty(input?.databaseUUID)
        if (databaseUUID) {
          const { startDatabase, stopDatabase, restartDatabase } = await import("./coolify/databases")
          const run = action === "start" ? startDatabase : action === "stop" ? stopDatabase : restartDatabase
          await run(client, databaseUUID, context.signal)
          return { content: `${action} requested for database ${databaseUUID}.`, metadata: { databaseUUID, action } }
        }
        const target = await resolveTarget(deps, input?.applicationUUID, context.signal)
        if (!target) return { content: "No application is linked to this project." }
        const run =
          action === "start" ? startApplication : action === "stop" ? stopApplication : restartApplication
        await run(client, target, context.signal)
        return { content: `${action} requested for application ${target}.`, metadata: { applicationUUID: target, action } }
      }

      const target = await resolveTarget(deps, input?.applicationUUID, context.signal)
      if (!target) return { content: formatResolution(await resolutionOf(deps, context.signal)) }

      if (action === "rollback") {
        const commit = requireString(input, "commit")
        await rollbackApplication(client, target, commit, context.signal)
        return {
          content: `Rollback requested for ${target} to commit ${commit}.`,
          metadata: { applicationUUID: target, commit },
        }
      }

      const tickets = await triggerDeploy(
        client,
        {
          uuid: target,
          ...(input?.force === true ? { force: true } : {}),
          ...(typeof input?.pr === "number" ? { pr: input.pr } : {}),
        },
        context.signal,
      )

      if (tickets.length === 0) {
        return { content: "Coolify accepted the request but returned no deployment.", metadata: { applicationUUID: target } }
      }

      const lines = tickets.map(
        (ticket) => `Queued deployment ${ticket.deploymentUUID || "(pending)"} for ${ticket.resourceUUID}. ${ticket.message}`,
      )

      const shouldWait = input?.wait !== false
      const first = tickets[0]
      if (!shouldWait || !first?.deploymentUUID) {
        return {
          content: [...lines, "Not waiting. Poll with `coolify_deployment_status`."].join("\n"),
          metadata: { applicationUUID: target, deploymentUUID: first?.deploymentUUID },
        }
      }

      await context.progress({ status: "deploying", deploymentUUID: first.deploymentUUID })
      const result = await waitForDeployment(client, first.deploymentUUID, {
        signal: context.signal,
        onProgress: async (update) => {
          deps.emitDeployProgress({
            applicationUUID: target,
            deploymentUUID: first.deploymentUUID,
            status: update.status,
            message: update.raw,
          })
          await context.progress({ status: update.status, deploymentUUID: first.deploymentUUID })
        },
      })

      return {
        content: [
          ...lines,
          result.timedOut
            ? `Deployment ${first.deploymentUUID} is still ${result.status} after waiting; it may continue in the background.`
            : `Deployment ${first.deploymentUUID} finished with status ${result.status}.`,
          result.status === "failed" && typeof result.deployment?.logs === "string"
            ? `\nLog tail:\n${result.deployment.logs.slice(-2_000)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
        metadata: { applicationUUID: target, deploymentUUID: first.deploymentUUID, status: result.status, polls: result.polls },
      }
    },
  }
}

function databasesTool(deps: ToolDeps): ToolSpec {
  return {
    name: "databases",
    tier: "read",
    description:
      "List Coolify databases with their project, environment, and runtime status. Check this before creating one so you do not provision a duplicate.",
    input: {
      type: "object",
      properties: {
        projectUUID: { type: "string", description: "Only show databases in this project." },
      },
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      const filter = typeof input?.projectUUID === "string" ? input.projectUUID : undefined
      const databases = await listDatabases(client, context.signal)
      const rows = filter ? databases.filter((database) => database.project_uuid === filter) : databases

      if (rows.length === 0) {
        return {
          content: filter
            ? `No databases found in project ${filter}.`
            : "No databases found on this instance.",
          metadata: { count: 0 },
        }
      }

      const lines = rows.map((database) => {
        const runtime = databaseRuntime(database)
        return [
          `- ${database.uuid ?? "?"}  ${database.type ?? "?"}  ${database.name ?? ""}`,
          `  status=${runtime.label}  project=${database.project_uuid ?? "?"}  env=${database.environment_name ?? "?"}`,
        ].join("\n")
      })

      return {
        content: `Databases (${rows.length}):\n${lines.join("\n")}`,
        metadata: { count: rows.length },
      }
    },
  }
}

function createDatabaseTool(deps: ToolDeps): ToolSpec {
  return {
    name: "create_database",
    tier: "write",
    description:
      "Create a Coolify database (postgresql, mysql, mariadb, mongodb, redis, keydb, clickhouse, dragonfly). This provisions real infrastructure, so confirm the type, name, and target project with the user before calling. Placement (project, environment, server) is taken from coolify.json or the linked application when not given. Record the result in coolify.json with configure_project.",
    input: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...DATABASE_TYPES] },
        name: { type: "string" },
        projectUUID: { type: "string" },
        environmentName: { type: "string" },
        environmentUUID: { type: "string" },
        serverUUID: { type: "string" },
        applicationUUID: { type: "string", description: "Infer placement from this application." },
        instantDeploy: { type: "boolean", description: "Deploy immediately after creating." },
        isPublic: { type: "boolean" },
        publicPort: { type: "integer" },
        limitsMemory: { type: "string" },
        limitsCpus: { type: "string" },
        settings: {
          type: "object",
          description: "Type-specific fields such as postgres_user, postgres_db, redis_password.",
          additionalProperties: true,
        },
      },
      required: ["type"],
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      if (!isDatabaseType(input?.type)) {
        return { content: `Unsupported database type. Choose one of: ${DATABASE_TYPES.join(", ")}.` }
      }

      const placement = await resolvePlacement(deps, input, context)
      if (!placement) {
        return {
          content: [
            "Cannot determine where to create the database.",
            "Provide `projectUUID` and `serverUUID`, or link an application (or add them to coolify.json) so placement can be inferred.",
          ].join("\n"),
        }
      }

      const created = await createDatabase(
        client,
        {
          type: input.type as DatabaseType,
          serverUUID: placement.serverUUID,
          projectUUID: placement.projectUUID,
          ...(placement.environmentName === undefined ? {} : { environmentName: placement.environmentName }),
          ...(placement.environmentUUID === undefined ? {} : { environmentUUID: placement.environmentUUID }),
          ...(typeof input?.name === "string" ? { name: input.name } : {}),
          ...(input?.instantDeploy === true ? { instantDeploy: true } : {}),
          ...(input?.isPublic === true ? { isPublic: true } : {}),
          ...(typeof input?.publicPort === "number" ? { publicPort: input.publicPort } : {}),
          ...(typeof input?.limitsMemory === "string" ? { limitsMemory: input.limitsMemory } : {}),
          ...(typeof input?.limitsCpus === "string" ? { limitsCpus: input.limitsCpus } : {}),
          ...(input?.settings && typeof input.settings === "object" && !Array.isArray(input.settings)
            ? { settings: input.settings as Record<string, unknown> }
            : {}),
        },
        context.signal,
      )

      const uuid = created?.uuid ?? "(uuid not returned)"
      return {
        content: [
          `Created ${input.type} database ${uuid}.`,
          `Project: ${placement.projectUUID}${placement.environmentName ? ` · environment ${placement.environmentName}` : ""}`,
          input?.instantDeploy === true ? "Deployment started." : "It is created but not deployed yet.",
          "Record it with configure_project so the mapping survives into the repository.",
        ].join("\n"),
        metadata: {
          databaseUUID: created?.uuid,
          type: input.type,
          projectUUID: placement.projectUUID,
          serverUUID: placement.serverUUID,
        },
      }
    },
  }
}

function configureProjectTool(deps: ToolDeps): ToolSpec {
  return {
    name: "configure_project",
    tier: "write",
    description:
      "Create or update `coolify.json` in the repository: the project UUID, one entry per application (required for a monorepo, keyed by a label with the directory it owns), and database UUIDs. This is how a monorepo records which application belongs to which directory. Ask the user before writing, and commit the file so the mapping is shared.",
    input: {
      type: "object",
      properties: {
        projectUUID: { type: "string" },
        environmentName: { type: "string" },
        serverUUID: { type: "string" },
        applicationUUID: { type: "string", description: "Shorthand for a single-application repository." },
        applications: {
          type: "object",
          description: "Map of label to { applicationUUID, path?, name? }.",
          additionalProperties: true,
        },
        databases: {
          type: "object",
          description: "Map of label to { databaseUUID?, type?, name?, path? }.",
          additionalProperties: true,
        },
        file: { type: "string", description: "Defaults to coolify.json at the project root." },
      },
      additionalProperties: false,
    },
    async run(input): Promise<ToolResult> {
      const file =
        typeof input?.file === "string" && input.file !== "" ? input.file : join(deps.directory, "coolify.json")

      const projectUUID = nonEmpty(input?.projectUUID)
      const environmentName = nonEmpty(input?.environmentName)
      const serverUUID = nonEmpty(input?.serverUUID)
      const applicationUUID = nonEmpty(input?.applicationUUID)
      const applications = asApplicationMap(input?.applications)
      const databases = asDatabaseMap(input?.databases)

      if (!projectUUID && !environmentName && !serverUUID && !applicationUUID && !applications && !databases) {
        return { content: "Nothing to write: provide projectUUID, applicationUUID, applications, or databases." }
      }

      const update: ProjectConfigUpdate = {
        ...(projectUUID ? { projectUUID } : {}),
        ...(environmentName ? { environmentName } : {}),
        ...(serverUUID ? { serverUUID } : {}),
        ...(applicationUUID ? { applicationUUID } : {}),
        ...(applications ? { applications } : {}),
        ...(databases ? { databases } : {}),
      }

      const config = await updateProjectConfig(file, update)

      deps.emitProjectChanged(file)

      const summary = [
        `Wrote ${file}.`,
        config.projectUUID ? `Project: ${config.projectUUID}` : "",
        config.environmentName ? `Environment: ${config.environmentName}` : "",
        config.applicationUUID ? `Application: ${config.applicationUUID}` : "",
        Object.keys(config.applications).length > 0
          ? `Applications: ${Object.entries(config.applications)
              .map(([key, entry]) => `${key}${entry.path ? ` (${entry.path})` : ""}`)
              .join(", ")}`
          : "",
        Object.keys(config.databases).length > 0
          ? `Databases: ${Object.keys(config.databases).join(", ")}`
          : "",
        "Commit this file so the mapping is shared.",
      ].filter(Boolean)

      return {
        content: summary.join("\n"),
        metadata: {
          file,
          applications: Object.keys(config.applications).length,
          databases: Object.keys(config.databases).length,
        },
      }
    },
  }
}