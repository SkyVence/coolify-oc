import {
  createBackup,
  databaseRuntime,
  listBackupExecutions,
  listBackups,
  updateBackup,
} from "../coolify/databases"
import { listStorages } from "../coolify/resources"
import {
  MISSING_CREDENTIAL,
  WITH_ENDPOINT,
  requireString,
  type ToolDeps,
  type ToolResult,
  type ToolSpec,
} from "./shared"

const READ_ACTIONS = ["get", "backups", "backup_executions", "storages"] as const

/** Inspect one database. */
export function databaseTool(deps: ToolDeps): ToolSpec {
  return {
    name: "database",
    tier: "read",
    description: `Inspect one Coolify database. Actions:
- get: type, image, runtime state, and connection details for a database UUID.
- backups: the configured backup schedules.
- backup_executions: past runs of one backup schedule.
- storages: volumes and file mounts attached to the database.`,
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...READ_ACTIONS] },
        databaseUUID: { type: "string" },
        backupUUID: { type: "string", description: "backup_executions: which schedule." },
      },
      required: ["action", "databaseUUID"],
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      const action = input?.action
      if (!READ_ACTIONS.includes(action)) {
        return { content: `Unknown action \`${action}\`. Choose one of: ${READ_ACTIONS.join(", ")}.` }
      }
      const uuid = requireString(input, "databaseUUID")

      if (action === "get") {
        const database = await client.request<Record<string, unknown>>({
          method: "GET",
          path: `/databases/${uuid}`,
          requires: "read",
          signal: context.signal,
        })
        const runtime = databaseRuntime(database as never)
        const lines = [
          `Database: ${String(database.name ?? "?")} (${uuid})`,
          `Type: ${String(database.type ?? database.database_type ?? "unknown")}`,
          `Runtime: ${runtime.label}`,
        ]
        for (const field of ["image", "is_public", "public_port", "limits_memory", "limits_cpus", "project_uuid", "environment_name"]) {
          const value = database[field]
          if (value === undefined || value === null || value === "") continue
          lines.push(`${field}: ${String(value)}`)
        }
        return { content: lines.join("\n"), metadata: { databaseUUID: uuid, runtime: runtime.label } }
      }

      if (action === "backups") {
        const backups = await listBackups(client, uuid, context.signal)
        if (backups.length === 0) return { content: "No backup schedules configured." }
        const lines = backups.map(
          (backup) =>
            `- ${backup.uuid ?? "?"}  ${backup.enabled ? "enabled" : "disabled"}  ${backup.frequency ?? ""}`.trim(),
        )
        return { content: `Backups (${backups.length}):\n${lines.join("\n")}` }
      }

      if (action === "backup_executions") {
        const backupUUID = requireString(input, "backupUUID")
        const executions = await listBackupExecutions(client, uuid, backupUUID, context.signal)
        if (!Array.isArray(executions) || executions.length === 0) {
          return { content: "No executions recorded for this backup." }
        }
        return {
          content: `Executions (${executions.length}):\n${executions
            .map((entry) => `- ${JSON.stringify(entry)}`)
            .join("\n")}`.slice(0, 4_000),
        }
      }

      const storages = await listStorages(client, "databases", uuid, context.signal)
      if (storages.length === 0) return { content: "No storages configured." }
      const lines = storages.map(
        (storage) => `- ${storage.uuid ?? "?"}  ${storage.type ?? "?"}  mount ${storage.mount_path ?? "?"}`,
      )
      return { content: `Storages (${storages.length}):\n${lines.join("\n")}` }
    },
  }
}

const MANAGE_ACTIONS = ["backup_create", "backup_update", "backup_trigger", "storage_create", "storage_update"] as const

/** Change a database's backups or storages. */
export function databaseManageTool(deps: ToolDeps): ToolSpec {
  return {
    name: "database_manage",
    tier: "write",
    description: `Configure backups and storages for one Coolify database. Actions:
- backup_create: schedule backups (frequency is a cron expression).
- backup_update: change an existing schedule.
- backup_trigger: run a backup now.
- storage_create / storage_update: add or change a volume or file mount.
This never deletes anything; use coolify_destroy for that.`,
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...MANAGE_ACTIONS] },
        databaseUUID: { type: "string" },
        backupUUID: { type: "string", description: "backup_update / backup_trigger." },
        backup: { type: "object", description: "backup_create / backup_update body.", additionalProperties: true },
        storage: { type: "object", description: "storage_create / storage_update body.", additionalProperties: true },
      },
      required: ["action", "databaseUUID"],
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      const action = input?.action
      if (!MANAGE_ACTIONS.includes(action)) {
        return { content: `Unknown action \`${action}\`. Choose one of: ${MANAGE_ACTIONS.join(", ")}.` }
      }
      const uuid = requireString(input, "databaseUUID")

      if (action === "backup_create") {
        const backup = body(input?.backup, "backup")
        if (typeof backup !== "object") return { content: "`backup` must be an object." }
        const created = await createBackup(client, uuid, backup as Record<string, unknown>, context.signal)
        return {
          content: `Created backup schedule ${created?.uuid ?? "(uuid not returned)"} on ${uuid}.`,
          metadata: { databaseUUID: uuid, backupUUID: created?.uuid },
        }
      }

      if (action === "backup_update") {
        const backupUUID = requireString(input, "backupUUID")
        const backup = body(input?.backup, "backup")
        if (typeof backup !== "object") return { content: "`backup` must be an object." }
        await updateBackup(client, uuid, backupUUID, backup as Record<string, unknown>, context.signal)
        return { content: `Updated backup schedule ${backupUUID}.` }
      }

      if (action === "backup_trigger") {
        const backupUUID = requireString(input, "backupUUID")
        const { triggerBackup } = await import("../coolify/databases")
        await triggerBackup(client, uuid, backupUUID, context.signal)
        return { content: `Triggered backup ${backupUUID}.`, metadata: { databaseUUID: uuid, backupUUID } }
      }

      const storage = body(input?.storage, "storage")
      if (typeof storage !== "object") return { content: "`storage` must be an object." }
      const { createStorage, updateStorage } = await import("../coolify/resources")
      if (action === "storage_create") {
        const created = await createStorage(client, "databases", uuid, storage as Record<string, unknown>, context.signal)
        return { content: `Created storage ${created?.uuid ?? "(uuid not returned)"} on ${uuid}.` }
      }
      await updateStorage(client, "databases", uuid, storage as Record<string, unknown>, context.signal)
      return { content: `Updated storage on ${uuid}.` }
    },
  }
}

function body(value: unknown, field: string): object | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as object) : undefined
}
