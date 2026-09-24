import {
  createEnvironment,
  createProject,
  deleteApplication,
  deleteEnvironment,
  deleteProject,
  deleteStorage,
  listEnvironments,
  migrateApplication,
  moveApplication,
} from "../coolify/resources"
import { deleteBackup, migrateDatabase, moveDatabase } from "../coolify/databases"
import {
  MISSING_CREDENTIAL,
  WITH_ENDPOINT,
  requireString,
  resolveTarget,
  type ToolDeps,
  type ToolResult,
  type ToolSpec,
} from "./shared"

const READ_ACTIONS = ["get", "environments", "resources"] as const

/** Projects and their environments. */
export function projectTool(deps: ToolDeps): ToolSpec {
  return {
    name: "project",
    tier: "read",
    description: `Inspect Coolify projects. Actions:
- get: a project's name and description.
- environments: the environment names and UUIDs inside a project.
- resources: every application and database the project contains, per environment.`,
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...READ_ACTIONS] },
        projectUUID: { type: "string", description: "Defaults to the project in coolify.json." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      const action = input?.action
      if (!READ_ACTIONS.includes(action)) {
        return { content: `Unknown action \`${action}\`. Choose one of: ${READ_ACTIONS.join(", ")}.` }
      }

      const projectUUID = await targetProject(deps, input?.projectUUID, context)
      if (!projectUUID) return { content: "No project UUID given and none recorded in coolify.json." }

      if (action === "get") {
        const project = await client.request<{ name?: string; description?: string | null }>({
          method: "GET",
          path: `/projects/${projectUUID}`,
          requires: "read",
          signal: context.signal,
        })
        return {
          content: [`Project: ${project?.name ?? "?"} (${projectUUID})`, project?.description ?? ""]
            .filter(Boolean)
            .join("\n"),
        }
      }

      const environments = await listEnvironments(client, projectUUID, context.signal)
      if (environments.length === 0) return { content: "This project has no environments." }

      if (action === "environments") {
        const lines = environments.map((env) => `- ${env.name}${env.uuid ? `  (${env.uuid})` : ""}`)
        return { content: `Environments (${environments.length}):\n${lines.join("\n")}` }
      }

      const lines: string[] = []
      for (const environment of environments) {
        const detail = await client
          .request<{ applications?: readonly { uuid?: string; name?: string }[]; databases?: readonly { uuid?: string; name?: string; type?: string }[] }>(
            {
              method: "GET",
              path: `/projects/${projectUUID}/${environment.uuid ?? environment.name}`,
              requires: "read",
              signal: context.signal,
            },
          )
          .catch(() => undefined)
        lines.push(`Environment ${environment.name}:`)
        for (const application of detail?.applications ?? []) {
          lines.push(`  app      ${application.uuid ?? "?"}  ${application.name ?? ""}`)
        }
        for (const database of detail?.databases ?? []) {
          lines.push(`  database ${database.uuid ?? "?"}  ${database.type ?? "?"}  ${database.name ?? ""}`)
        }
      }
      return { content: lines.join("\n") }
    },
  }
}

const MANAGE_ACTIONS = ["create", "environment_create"] as const

export function projectManageTool(deps: ToolDeps): ToolSpec {
  return {
    name: "project_manage",
    tier: "write",
    description: `Create Coolify structure. Actions:
- create: a new project, optionally as a monorepo's home.
- environment_create: a new environment inside a project (Coolify creates "production" automatically).
Record the result with coolify_configure_project so the mapping survives.`,
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...MANAGE_ACTIONS] },
        name: { type: "string", description: "Name for the project or environment." },
        description: { type: "string" },
        projectUUID: { type: "string", description: "environment_create: which project." },
      },
      required: ["action", "name"],
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      const action = input?.action
      const name = requireString(input, "name")

      if (action === "create") {
        const created = await createProject(
          client,
          {
            name,
            ...(typeof input?.description === "string" ? { description: input.description } : {}),
          },
          context.signal,
        )
        return {
          content: [
            `Created project ${name}${created?.uuid ? ` (${created.uuid})` : ""}.`,
            "Coolify adds a `production` environment. Record it with coolify_configure_project.",
          ].join("\n"),
          metadata: { projectUUID: created?.uuid },
        }
      }

      if (action === "environment_create") {
        const projectUUID = await targetProject(deps, input?.projectUUID, context)
        if (!projectUUID) return { content: "`projectUUID` is required, or record one in coolify.json." }
        const created = await createEnvironment(client, projectUUID, name, context.signal)
        return {
          content: `Created environment ${name} in ${projectUUID}${created?.uuid ? ` (${created.uuid})` : ""}.`,
          metadata: { projectUUID, environmentUUID: created?.uuid },
        }
      }

      return { content: `Unknown action \`${action}\`. Choose one of: ${MANAGE_ACTIONS.join(", ")}.` }
    },
  }
}

const DESTROY_ACTIONS = [
  "delete_application",
  "delete_database",
  "delete_project",
  "delete_environment",
  "delete_storage",
  "delete_backup",
  "migrate_application",
  "move_application",
  "migrate_database",
  "move_database",
] as const

/**
 * Irreversible operations.
 *
 * Every action requires an explicit UUID — nothing here defaults to "the linked
 * application" — so a misread prompt cannot delete production. It carries the
 * `coolify.destructive` permission, which is the one to deny outright.
 */
export function destroyTool(deps: ToolDeps): ToolSpec {
  return {
    name: "destroy",
    tier: "destructive",
    description: `Delete or move Coolify resources. Every action requires an explicit UUID; none of them fall back to the linked application.

- delete_application / delete_database / delete_project / delete_environment / delete_storage / delete_backup
- migrate_application / migrate_database: move a resource to another server
- move_application / move_database: move a resource to another environment

Confirm what will be destroyed before calling. Deleting a database or application can destroy data.`,
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...DESTROY_ACTIONS] },
        applicationUUID: { type: "string" },
        databaseUUID: { type: "string" },
        projectUUID: { type: "string" },
        environmentNameOrUUID: { type: "string" },
        storageUUID: { type: "string" },
        backupUUID: { type: "string" },
        serverUUID: { type: "string", description: "migrate_*: destination server." },
        environmentUUID: { type: "string", description: "move_*: destination environment." },
        resource: { type: "string", enum: ["applications", "databases"], description: "delete_storage: which kind owns it." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      const action = input?.action
      if (!DESTROY_ACTIONS.includes(action)) {
        return { content: `Unknown action \`${action}\`. Choose one of: ${DESTROY_ACTIONS.join(", ")}.` }
      }

      switch (action) {
        case "delete_application": {
          const uuid = requireString(input, "applicationUUID")
          await deleteApplication(client, uuid, context.signal)
          return { content: `Deleted application ${uuid}.`, metadata: { applicationUUID: uuid } }
        }
        case "delete_database": {
          const uuid = requireString(input, "databaseUUID")
          const { deleteDatabase } = await import("../coolify/databases")
          await deleteDatabase(client, uuid, context.signal)
          return { content: `Deleted database ${uuid}. Its volumes were removed too.`, metadata: { databaseUUID: uuid } }
        }
        case "delete_project": {
          const uuid = requireString(input, "projectUUID")
          await deleteProject(client, uuid, context.signal)
          return { content: `Deleted project ${uuid}.`, metadata: { projectUUID: uuid } }
        }
        case "delete_environment": {
          const projectUUID = requireString(input, "projectUUID")
          const nameOrUUID = requireString(input, "environmentNameOrUUID")
          await deleteEnvironment(client, projectUUID, nameOrUUID, context.signal)
          return { content: `Deleted environment ${nameOrUUID} from ${projectUUID}.` }
        }
        case "delete_storage": {
          const resource = input?.resource
          if (resource !== "applications" && resource !== "databases") {
            return { content: "`resource` must be `applications` or `databases`." }
          }
          const uuid = resource === "applications" ? requireString(input, "applicationUUID") : requireString(input, "databaseUUID")
          const storageUUID = requireString(input, "storageUUID")
          await deleteStorage(client, resource, uuid, storageUUID, context.signal)
          return { content: `Deleted storage ${storageUUID} from ${uuid}.` }
        }
        case "delete_backup": {
          const databaseUUID = requireString(input, "databaseUUID")
          const backupUUID = requireString(input, "backupUUID")
          await deleteBackup(client, databaseUUID, backupUUID, context.signal)
          return { content: `Deleted backup configuration ${backupUUID} from ${databaseUUID}.` }
        }
        case "migrate_application": {
          const uuid = requireString(input, "applicationUUID")
          const serverUUID = requireString(input, "serverUUID")
          await migrateApplication(client, uuid, serverUUID, context.signal)
          return { content: `Migrating application ${uuid} to server ${serverUUID}.` }
        }
        case "migrate_database": {
          const uuid = requireString(input, "databaseUUID")
          const serverUUID = requireString(input, "serverUUID")
          await migrateDatabase(client, uuid, serverUUID, context.signal)
          return { content: `Migrating database ${uuid} to server ${serverUUID}.` }
        }
        case "move_application": {
          const uuid = requireString(input, "applicationUUID")
          const environmentUUID = requireString(input, "environmentUUID")
          await moveApplication(client, uuid, environmentUUID, context.signal)
          return { content: `Moved application ${uuid} to environment ${environmentUUID}.` }
        }
        default: {
          const uuid = requireString(input, "databaseUUID")
          const environmentUUID = requireString(input, "environmentUUID")
          await moveDatabase(client, uuid, environmentUUID, context.signal)
          return { content: `Moved database ${uuid} to environment ${environmentUUID}.` }
        }
      }
    },
  }
}

/** The project from an explicit argument, then coolify.json, then the linked app. */
async function targetProject(deps: ToolDeps, explicit: unknown, context: { signal: AbortSignal }): Promise<string | undefined> {
  if (typeof explicit === "string" && explicit !== "") return explicit

  const { findProjectConfig } = await import("../project-config")
  const config = await findProjectConfig(deps.directory)
  if (config?.projectUUID) return config.projectUUID

  const link = deps.getLink()
  if (link?.projectUUID) return link.projectUUID

  const target = await resolveTarget(deps, undefined, context.signal).catch(() => undefined)
  if (!target) return undefined
  const application = await deps
    .getClient()
    ?.request<{ project_uuid?: string }>({
      method: "GET",
      path: `/applications/${target}`,
      requires: "read",
      signal: context.signal,
    })
    .catch(() => undefined)
  return application?.project_uuid
}
