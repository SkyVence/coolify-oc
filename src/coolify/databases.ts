import type { CoolifyClient } from "./client"
import { parseApplicationStatus, type RuntimeStatus } from "./runtime"

/**
 * Coolify database resources.
 *
 * Every database type has its own create endpoint with type-specific fields, but
 * they share the same placement and lifecycle shape.
 */
export const DATABASE_TYPES = [
  "postgresql",
  "mysql",
  "mariadb",
  "mongodb",
  "redis",
  "keydb",
  "clickhouse",
  "dragonfly",
] as const

export type DatabaseType = (typeof DATABASE_TYPES)[number]

export function isDatabaseType(value: unknown): value is DatabaseType {
  return typeof value === "string" && (DATABASE_TYPES as readonly string[]).includes(value)
}

export interface CoolifyDatabase {
  readonly uuid?: string
  readonly id?: number
  readonly name?: string
  readonly type?: string
  readonly status?: string
  readonly project_uuid?: string
  readonly environment_name?: string
  readonly server_uuid?: string
  readonly internal_db_url?: string
  readonly external_db_url?: string
  readonly image?: string
  readonly [key: string]: unknown
}

export function databaseRuntime(database: CoolifyDatabase): RuntimeStatus {
  return parseApplicationStatus(typeof database.status === "string" ? database.status : undefined)
}

/**
 * `GET /databases` is documented as returning an opaque string ("Content is very
 * complex. Will be implemented later."), so accept every plausible shape rather
 * than trusting the schema. A live instance returned entries carrying `uuid`,
 * `name`, and `status` but no `type` or `project_uuid`, so those are treated as
 * optional and the type is recovered from a grouping key when present.
 */
export function normalizeDatabaseList(raw: unknown): CoolifyDatabase[] {
  const value = typeof raw === "string" ? tryParse(raw) : raw
  if (Array.isArray(value)) return value.filter(isRecord).map(normalizeDatabase) as CoolifyDatabase[]
  if (isRecord(value)) {
    for (const key of ["databases", "data", "resources"]) {
      const nested = value[key]
      if (Array.isArray(nested)) return nested.filter(isRecord).map(normalizeDatabase) as CoolifyDatabase[]
    }
    // Grouped by type, e.g. { postgresql: [...], redis: [...] }
    const grouped: CoolifyDatabase[] = []
    for (const [key, nested] of Object.entries(value)) {
      if (!Array.isArray(nested)) continue
      for (const entry of nested.filter(isRecord)) {
        const database = normalizeDatabase(entry) as CoolifyDatabase
        grouped.push(database.type ? database : { ...database, type: key })
      }
    }
    if (grouped.length > 0) return grouped
  }
  return []
}

/** Map the field aliases Coolify has used for the same concepts. */
function normalizeDatabase(value: Record<string, unknown>): Record<string, unknown> {
  const type = value.type ?? value.database_type ?? value.engine
  const project = value.project_uuid ?? (isRecord(value.project) ? value.project.uuid : undefined)
  const environment =
    value.environment_name ?? (isRecord(value.environment) ? value.environment.name : undefined)
  return {
    ...value,
    ...(typeof type === "string" ? { type } : {}),
    ...(typeof project === "string" ? { project_uuid: project } : {}),
    ...(typeof environment === "string" ? { environment_name: environment } : {}),
  }
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export async function listDatabases(client: CoolifyClient, signal?: AbortSignal): Promise<CoolifyDatabase[]> {
  const raw = await client.request<unknown>({ method: "GET", path: "/databases", requires: "read", signal })
  return normalizeDatabaseList(raw)
}

export async function getDatabase(
  client: CoolifyClient,
  uuid: string,
  signal?: AbortSignal,
): Promise<CoolifyDatabase> {
  return client.request({ method: "GET", path: `/databases/${uuid}`, requires: "read", signal })
}

export interface CreateDatabaseInput {
  readonly type: DatabaseType
  readonly serverUUID: string
  readonly projectUUID: string
  /** Coolify accepts a name or a UUID; send whichever is known, prefer the UUID. */
  readonly environmentName?: string
  readonly environmentUUID?: string
  readonly name?: string
  readonly description?: string
  readonly image?: string
  readonly instantDeploy?: boolean
  readonly isPublic?: boolean
  readonly publicPort?: number
  readonly limitsMemory?: string
  readonly limitsCpus?: string
  /** Type-specific fields, e.g. `postgres_user`, `redis_password`. */
  readonly settings?: Readonly<Record<string, unknown>>
}

export async function createDatabase(
  client: CoolifyClient,
  input: CreateDatabaseInput,
  signal?: AbortSignal,
): Promise<{ uuid?: string }> {
  const body: Record<string, unknown> = {
    server_uuid: input.serverUUID,
    project_uuid: input.projectUUID,
    ...(input.environmentUUID === undefined ? {} : { environment_uuid: input.environmentUUID }),
    ...(input.environmentName === undefined ? {} : { environment_name: input.environmentName }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.image === undefined ? {} : { image: input.image }),
    ...(input.instantDeploy === undefined ? {} : { instant_deploy: input.instantDeploy }),
    ...(input.isPublic === undefined ? {} : { is_public: input.isPublic }),
    ...(input.publicPort === undefined ? {} : { public_port: input.publicPort }),
    ...(input.limitsMemory === undefined ? {} : { limits_memory: input.limitsMemory }),
    ...(input.limitsCpus === undefined ? {} : { limits_cpus: input.limitsCpus }),
    ...(input.settings ?? {}),
  }

  return client.request({
    method: "POST",
    path: `/databases/${input.type}`,
    body,
    requires: "write",
    signal,
  })
}

export function deleteDatabase(
  client: CoolifyClient,
  uuid: string,
  signal?: AbortSignal,
): Promise<{ message?: string }> {
  return client.request({ method: "DELETE", path: `/databases/${uuid}`, requires: "write", signal })
}

export function startDatabase(client: CoolifyClient, uuid: string, signal?: AbortSignal): Promise<unknown> {
  return client.request({ method: "POST", path: `/databases/${uuid}/start`, requires: "deploy", signal })
}

export function stopDatabase(client: CoolifyClient, uuid: string, signal?: AbortSignal): Promise<unknown> {
  return client.request({ method: "POST", path: `/databases/${uuid}/stop`, requires: "deploy", signal })
}

export function restartDatabase(client: CoolifyClient, uuid: string, signal?: AbortSignal): Promise<unknown> {
  return client.request({ method: "POST", path: `/databases/${uuid}/restart`, requires: "deploy", signal })
}

// --- Backups ---------------------------------------------------------------

export interface CoolifyBackup {
  readonly uuid?: string
  readonly frequency?: string
  readonly enabled?: boolean
  readonly [key: string]: unknown
}

export function listBackups(
  client: CoolifyClient,
  databaseUUID: string,
  signal?: AbortSignal,
): Promise<CoolifyBackup[]> {
  return client.request({ method: "GET", path: `/databases/${databaseUUID}/backups`, requires: "read", signal })
}

export function createBackup(
  client: CoolifyClient,
  databaseUUID: string,
  backup: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<{ uuid?: string }> {
  return client.request({
    method: "POST",
    path: `/databases/${databaseUUID}/backups`,
    body: backup,
    requires: "write",
    signal,
  })
}

export function updateBackup(
  client: CoolifyClient,
  databaseUUID: string,
  backupUUID: string,
  backup: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request({
    method: "PATCH",
    path: `/databases/${databaseUUID}/backups/${backupUUID}`,
    body: backup,
    requires: "write",
    signal,
  })
}

export function deleteBackup(
  client: CoolifyClient,
  databaseUUID: string,
  backupUUID: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request({
    method: "DELETE",
    path: `/databases/${databaseUUID}/backups/${backupUUID}`,
    requires: "write",
    signal,
  })
}

export function triggerBackup(
  client: CoolifyClient,
  databaseUUID: string,
  backupUUID: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request({
    method: "POST",
    path: `/databases/${databaseUUID}/backups/${backupUUID}/run`,
    requires: "write",
    signal,
  })
}

export function listBackupExecutions(
  client: CoolifyClient,
  databaseUUID: string,
  backupUUID: string,
  signal?: AbortSignal,
): Promise<unknown[]> {
  return client.request({
    method: "GET",
    path: `/databases/${databaseUUID}/backups/${backupUUID}/executions`,
    requires: "read",
    signal,
  })
}

export function migrateDatabase(
  client: CoolifyClient,
  uuid: string,
  serverUUID: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request({
    method: "POST",
    path: `/databases/${uuid}/migrate`,
    body: { server_uuid: serverUUID },
    requires: "write",
    signal,
  })
}

export function moveDatabase(
  client: CoolifyClient,
  uuid: string,
  environmentUUID: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request({
    method: "POST",
    path: `/databases/${uuid}/move`,
    body: { environment_uuid: environmentUUID },
    requires: "write",
    signal,
  })
}
