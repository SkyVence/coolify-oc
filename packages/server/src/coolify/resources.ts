import type { CoolifyClient } from "./client"
import type {
  CoolifyApplication,
  CoolifyDestination,
  CoolifyEnvVariable,
  CoolifyEnvironment,
  CoolifyProject,
  CoolifyServer,
} from "./types"

// --- Projects --------------------------------------------------------------

export function listProjects(client: CoolifyClient, signal?: AbortSignal): Promise<CoolifyProject[]> {
  return client.request({ method: "GET", path: "/projects", requires: "read", signal })
}

export function getProject(client: CoolifyClient, uuid: string, signal?: AbortSignal): Promise<CoolifyProject> {
  return client.request({ method: "GET", path: `/projects/${uuid}`, requires: "read", signal })
}

export function listEnvironments(
  client: CoolifyClient,
  projectUUID: string,
  signal?: AbortSignal,
): Promise<CoolifyEnvironment[]> {
  return client.request({
    method: "GET",
    path: `/projects/${projectUUID}/environments`,
    requires: "read",
    signal,
  })
}

// --- Applications ----------------------------------------------------------

export function listApplications(client: CoolifyClient, signal?: AbortSignal): Promise<CoolifyApplication[]> {
  return client.request({ method: "GET", path: "/applications", requires: "read", signal })
}

export function getApplication(
  client: CoolifyClient,
  uuid: string,
  signal?: AbortSignal,
): Promise<CoolifyApplication> {
  return client.request({ method: "GET", path: `/applications/${uuid}`, requires: "read", signal })
}

/**
 * Update an application's deployment settings.
 *
 * `settings` must be a subset of the `PATCH /applications/{uuid}` fields; see
 * `APPLICATION_SETTING_FIELDS` in `resolve.ts` for the allow-list the model is
 * offered.
 */
export function updateApplication(
  client: CoolifyClient,
  uuid: string,
  settings: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<CoolifyApplication> {
  return client.request({ method: "PATCH", path: `/applications/${uuid}`, body: settings, requires: "write", signal })
}

export function deleteApplication(
  client: CoolifyClient,
  uuid: string,
  signal?: AbortSignal,
): Promise<{ message?: string }> {
  return client.request({ method: "DELETE", path: `/applications/${uuid}`, requires: "write", signal })
}

export function listApplicationDestinations(
  client: CoolifyClient,
  uuid: string,
  signal?: AbortSignal,
): Promise<CoolifyDestination[]> {
  return client.request({
    method: "GET",
    path: `/applications/${uuid}/destinations`,
    requires: "read",
    signal,
  })
}

/**
 * Runtime logs for an application.
 *
 * Coolify documents logs as sensitive, so without the `read:sensitive` ability
 * this can come back empty even for a running container. Callers should say so
 * rather than reporting "no logs".
 */
export async function getApplicationLogs(
  client: CoolifyClient,
  uuid: string,
  options: { lines?: number; showTimestamps?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const result = await client.request<{ logs?: string } | string>({
    method: "GET",
    path: `/applications/${uuid}/logs`,
    query: { lines: options.lines, show_timestamps: options.showTimestamps },
    requires: "read",
    signal: options.signal,
  })
  if (typeof result === "string") return result
  return typeof result?.logs === "string" ? result.logs : ""
}

export interface CoolifyRollbackImage {
  readonly image_name?: string
  readonly commit?: string
  readonly created_at?: string
  readonly [key: string]: unknown
}

export function listRollbackImages(
  client: CoolifyClient,
  uuid: string,
  signal?: AbortSignal,
): Promise<CoolifyRollbackImage[]> {
  return client.request({ method: "GET", path: `/applications/${uuid}/rollback-images`, requires: "read", signal })
}

export function rollbackApplication(
  client: CoolifyClient,
  uuid: string,
  commit: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request({
    method: "POST",
    path: `/applications/${uuid}/rollback`,
    body: { commit },
    requires: "deploy",
    signal,
  })
}

// --- Storage ---------------------------------------------------------------

export interface CoolifyStorage {
  readonly uuid?: string
  readonly type?: string
  readonly mount_path?: string
  readonly name?: string
  readonly host_path?: string
  readonly [key: string]: unknown
}

export function listStorages(
  client: CoolifyClient,
  resource: "applications" | "databases" | "services",
  uuid: string,
  signal?: AbortSignal,
): Promise<CoolifyStorage[]> {
  return client.request({ method: "GET", path: `/${resource}/${uuid}/storages`, requires: "read", signal })
}

export function createStorage(
  client: CoolifyClient,
  resource: "applications" | "databases",
  uuid: string,
  storage: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<{ uuid?: string }> {
  return client.request({
    method: "POST",
    path: `/${resource}/${uuid}/storages`,
    body: storage,
    requires: "write",
    signal,
  })
}

export function updateStorage(
  client: CoolifyClient,
  resource: "applications" | "databases",
  uuid: string,
  storage: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request({
    method: "PATCH",
    path: `/${resource}/${uuid}/storages`,
    body: storage,
    requires: "write",
    signal,
  })
}

export function deleteStorage(
  client: CoolifyClient,
  resource: "applications" | "databases" | "services",
  uuid: string,
  storageUUID: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request({
    method: "DELETE",
    path: `/${resource}/${uuid}/storages/${storageUUID}`,
    requires: "write",
    signal,
  })
}

// --- Projects and environments --------------------------------------------

export function createProject(
  client: CoolifyClient,
  input: { name: string; description?: string },
  signal?: AbortSignal,
): Promise<{ uuid?: string }> {
  return client.request({ method: "POST", path: "/projects", body: input, requires: "write", signal })
}

export function createEnvironment(
  client: CoolifyClient,
  projectUUID: string,
  name: string,
  signal?: AbortSignal,
): Promise<{ uuid?: string }> {
  return client.request({
    method: "POST",
    path: `/projects/${projectUUID}/environments`,
    body: { name },
    requires: "write",
    signal,
  })
}

export function deleteEnvironment(
  client: CoolifyClient,
  projectUUID: string,
  nameOrUUID: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request({
    method: "DELETE",
    path: `/projects/${projectUUID}/environments/${nameOrUUID}`,
    requires: "write",
    signal,
  })
}

// --- Credentials available for private sources ------------------------------

export interface CoolifyGithubApp {
  readonly uuid?: string
  readonly name?: string
  readonly [key: string]: unknown
}

export function listGithubApps(client: CoolifyClient, signal?: AbortSignal): Promise<CoolifyGithubApp[]> {
  return client.request({ method: "GET", path: "/github-apps", requires: "read", signal })
}

export interface CoolifyPrivateKey {
  readonly uuid?: string
  readonly name?: string
  readonly [key: string]: unknown
}

export function listPrivateKeys(client: CoolifyClient, signal?: AbortSignal): Promise<CoolifyPrivateKey[]> {
  return client.request({ method: "GET", path: "/security/keys", requires: "read", signal })
}

// --- Environment variables -------------------------------------------------

export function listEnvs(
  client: CoolifyClient,
  uuid: string,
  signal?: AbortSignal,
): Promise<CoolifyEnvVariable[]> {
  return client.request({ method: "GET", path: `/applications/${uuid}/envs`, requires: "read", signal })
}

export function createEnv(
  client: CoolifyClient,
  uuid: string,
  env: { key: string; value: string; is_preview?: boolean; is_literal?: boolean; is_multiline?: boolean },
  signal?: AbortSignal,
): Promise<{ uuid?: string }> {
  return client.request({ method: "POST", path: `/applications/${uuid}/envs`, body: env, requires: "write", signal })
}

export function updateEnv(
  client: CoolifyClient,
  uuid: string,
  env: { key: string; value: string; is_preview?: boolean; is_literal?: boolean; is_multiline?: boolean },
  signal?: AbortSignal,
): Promise<CoolifyEnvVariable> {
  return client.request({ method: "PATCH", path: `/applications/${uuid}/envs`, body: env, requires: "write", signal })
}

export function deleteEnv(
  client: CoolifyClient,
  uuid: string,
  envUUID: string,
  signal?: AbortSignal,
): Promise<{ message?: string }> {
  return client.request({
    method: "DELETE",
    path: `/applications/${uuid}/envs/${envUUID}`,
    requires: "write",
    signal,
  })
}

// --- Lifecycle -------------------------------------------------------------

export function startApplication(
  client: CoolifyClient,
  uuid: string,
  signal?: AbortSignal,
): Promise<{ message?: string }> {
  return client.request({ method: "POST", path: `/applications/${uuid}/start`, requires: "deploy", signal })
}

export function stopApplication(
  client: CoolifyClient,
  uuid: string,
  signal?: AbortSignal,
): Promise<{ message?: string }> {
  return client.request({ method: "POST", path: `/applications/${uuid}/stop`, requires: "deploy", signal })
}

export function restartApplication(
  client: CoolifyClient,
  uuid: string,
  signal?: AbortSignal,
): Promise<{ message?: string }> {
  return client.request({ method: "POST", path: `/applications/${uuid}/restart`, requires: "deploy", signal })
}

// --- Infrastructure --------------------------------------------------------

export function listServers(client: CoolifyClient, signal?: AbortSignal): Promise<CoolifyServer[]> {
  return client.request({ method: "GET", path: "/servers", requires: "read", signal })
}

export function listDestinations(client: CoolifyClient, signal?: AbortSignal): Promise<CoolifyDestination[]> {
  return client.request({ method: "GET", path: "/destinations", requires: "read", signal })
}

// --- Lifecycle, migration, tags -------------------------------------------

export function deleteProject(
  client: CoolifyClient,
  uuid: string,
  signal?: AbortSignal,
): Promise<{ message?: string }> {
  return client.request({ method: "DELETE", path: `/projects/${uuid}`, requires: "write", signal })
}

export function migrateApplication(
  client: CoolifyClient,
  uuid: string,
  serverUUID: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request({
    method: "POST",
    path: `/applications/${uuid}/migrate`,
    body: { server_uuid: serverUUID },
    requires: "write",
    signal,
  })
}

export function moveApplication(
  client: CoolifyClient,
  uuid: string,
  environmentUUID: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return client.request({
    method: "POST",
    path: `/applications/${uuid}/move`,
    body: { environment_uuid: environmentUUID },
    requires: "write",
    signal,
  })
}
