import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { CoolifyClient } from "../coolify/client"
import { listApplicationDeployments, listDeployments } from "../coolify/deploy"
import { getApplication, listEnvironments } from "../coolify/resources"
import {
  granted,
  type CapabilityReport,
  type CoolifyApplication,
  type CoolifyDeployment,
} from "../coolify/types"
import { findProjectConfig } from "../project-config"
import { resolveProject, type Resolution } from "../resolve"
import { readLink, type ResolvedLink, type StorageLike } from "../store"

/**
 * Permission tiers.
 *
 * Every tool declares one, and `index.ts` turns it into a permission action
 * named `coolify.<tier>`. One tool can only carry one permission name, so tools
 * are kept homogeneous: a read-only action never shares a tool with a mutating
 * one. The runtime's default effect is `ask`, and a `deny` rule with resource
 * `*` removes the tool from the model's view entirely.
 */
export type ToolTier = "read" | "write" | "deploy" | "destructive" | "secrets"

export interface ToolResult {
  readonly content: string
  readonly metadata?: Record<string, unknown>
}

export interface ToolSpec {
  readonly name: string
  readonly description: string
  /** JSON Schema for the tool input. */
  readonly input: Record<string, unknown>
  readonly tier: ToolTier
  readonly run: (input: any, context: ToolContext) => Promise<ToolResult>
}

export interface ToolDeps {
  readonly store: StorageLike
  readonly projectID: string
  readonly directory: string
  readonly endpoint: string | undefined
  readonly getClient: () => CoolifyClient | undefined
  readonly getCapabilities: () => CapabilityReport | undefined
  readonly getLink: () => ResolvedLink | undefined
  readonly setLink: (link: ResolvedLink | undefined) => Promise<void>
  readonly emitDeployProgress: (data: {
    applicationUUID: string
    deploymentUUID: string
    status: string
    message: string
  }) => void
  /**
   * Announce that `coolify.json` changed, so any open UI re-reads the mapping.
   * Without this the sidebar only refreshes on its periodic timer.
   */
  readonly emitProjectChanged: (file: string) => void
}

export const MISSING_ENDPOINT =
  "Coolify is not configured. Set the `endpoint` plugin option, or run `/coolify` to set it."

export const MISSING_CREDENTIAL =
  "No Coolify API token is connected. Run `/coolify` in the TUI to add one."

export function WITH_ENDPOINT(deps: ToolDeps, message: string): string {
  return deps.endpoint ? message : MISSING_ENDPOINT
}

export async function resolutionOf(deps: ToolDeps, signal?: AbortSignal): Promise<Resolution> {
  return resolveProject({
    store: deps.store,
    projectID: deps.projectID,
    directory: deps.directory,
    client: deps.getClient(),
    capabilities: deps.getCapabilities(),
    ...(signal ? { signal } : {}),
  })
}

/** Resolve the application a tool should act on: explicit arg, then link, then discovery. */
export async function resolveTarget(
  deps: ToolDeps,
  explicit: unknown,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (typeof explicit === "string" && explicit !== "") return explicit
  const link = deps.getLink() ?? (await readLink(deps.store, deps.projectID))
  if (link) return link.applicationUUID
  const resolution = await resolutionOf(deps, signal)
  if (resolution.best && resolution.source !== "none") {
    await deps.setLink({
      applicationUUID: resolution.best.applicationUUID,
      ...(resolution.best.name ? { name: resolution.best.name } : {}),
      ...(resolution.best.gitRepository ? { gitRepository: resolution.best.gitRepository } : {}),
      ...(resolution.best.projectUUID ? { projectUUID: resolution.best.projectUUID } : {}),
      ...(resolution.best.environmentName ? { environmentName: resolution.best.environmentName } : {}),
      ...(resolution.best.serverUUID ? { serverUUID: resolution.best.serverUUID } : {}),
      linkedAt: Date.now(),
      source: resolution.source === "discovered" ? "git-remote" : "pin",
    })
    return resolution.best.applicationUUID
  }
  return undefined
}

export async function fetchApplication(
  deps: ToolDeps,
  applicationUUID: string,
  signal?: AbortSignal,
): Promise<CoolifyApplication | undefined> {
  const client = deps.getClient()
  if (!client || !granted(deps.getCapabilities(), "read")) return undefined
  try {
    return await getApplication(client, applicationUUID, signal)
  } catch (error) {
    if (error instanceof Error && "kind" in error) {
      const kind = (error as { kind: string }).kind
      if (kind === "not_found" || kind === "forbidden" || kind === "missing_sensitive" || kind === "unauthorized") {
        return undefined
      }
    }
    throw error
  }
}

/**
 * The latest deployment for one application.
 *
 * `getQueue` supplies the instance-wide deployment queue lazily and lets the
 * caller share one fetch across every application. Without it, a project whose
 * apps have no per-app history downloads the whole queue once per app.
 */
export async function latestDeploymentFor(
  client: CoolifyClient,
  applicationUUID: string,
  signal?: AbortSignal,
  getQueue?: () => Promise<readonly CoolifyDeployment[]>,
): Promise<CoolifyDeployment | undefined> {
  try {
    const history = await listApplicationDeployments(client, applicationUUID, {
      take: 1,
      ...(signal ? { signal } : {}),
    })
    const first = (history as readonly CoolifyDeployment[])[0]
    if (first && (first.deployment_uuid || first.status)) return first
  } catch {
    // Fall through to the shared queue listing.
  }
  try {
    const queue = getQueue ? await getQueue() : await listDeployments(client, signal)
    return queue.find((deployment) => deployment.application_id === applicationUUID)
  } catch {
    return undefined
  }
}

export function formatResolution(resolution: Resolution, linked?: ResolvedLink): string {
  const lines: string[] = []
  if (linked) lines.push(`Linked application: ${linked.name ?? linked.applicationUUID} (${linked.applicationUUID}).`)
  lines.push(`Resolution: ${resolution.source}${resolution.ambiguous ? " (ambiguous)" : ""}.`)

  if (resolution.config) {
    const config = resolution.config
    lines.push("", `Repo config: ${config.relativeFile}`)
    if (config.projectUUID) lines.push(`- projectUUID: ${config.projectUUID}`)
    if (config.environmentName) lines.push(`- environment: ${config.environmentName}`)
    if (config.serverUUID) lines.push(`- serverUUID: ${config.serverUUID}`)
    const applications = Object.entries(config.applications)
    if (applications.length > 0) {
      lines.push(
        `- applications: ${applications
          .map(([key, entry]) => `${key}${entry.path ? ` (${entry.path})` : ""}`)
          .join(", ")}`,
      )
    }
    const databases = Object.entries(config.databases)
    if (databases.length > 0) {
      lines.push(
        `- databases: ${databases.map(([key, entry]) => `${key}${entry.type ? ` (${entry.type})` : ""}`).join(", ")}`,
      )
    }
    if (config.selected) lines.push(`- selected: ${config.selected.key} — ${config.selected.reason}`)
  }

  if (resolution.candidates.length > 0) {
    lines.push(
      "Candidates:",
      ...resolution.candidates
        .slice(0, 10)
        .map(
          (candidate) =>
            `- ${candidate.applicationUUID}  ${candidate.name}  score ${candidate.score}${
              candidate.reasons.length > 0 ? `  [${candidate.reasons.join(", ")}]` : ""
            }`,
        ),
    )
  }
  if (resolution.notes.length > 0) lines.push("", ...resolution.notes.map((note) => `- ${note}`))
  if (!linked && resolution.source === "none") {
    lines.push(
      "",
      'Nothing is linked. Either call `coolify_link` with a UUID, or record the mapping in `coolify.json` with `configure_project` (projectUUID plus an entry per application, which is what a monorepo needs).',
    )
  }
  return lines.join("\n")
}

export function requireString(input: any, key: string): string {
  const value = input?.[key]
  if (typeof value !== "string" || value === "") throw new Error(`\`${key}\` is required and must be a non-empty string.`)
  return value
}

export function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

export function optionalString<Key extends string>(key: Key, value: unknown): Record<Key, string> | Record<string, never> {
  return typeof value === "string" && value !== "" ? ({ [key]: value } as Record<Key, string>) : {}
}

/** Placement for a new database: explicit arguments, then coolify.json, then the linked app. */
export async function resolvePlacement(
  deps: ToolDeps,
  input: any,
  context: ToolContext,
): Promise<{ projectUUID: string; serverUUID: string; environmentName?: string; environmentUUID?: string } | undefined> {
  const client = deps.getClient()
  if (!client) return undefined

  let projectUUID = nonEmpty(input?.projectUUID)
  let serverUUID = nonEmpty(input?.serverUUID)
  let environmentName = nonEmpty(input?.environmentName)
  let environmentUUID = nonEmpty(input?.environmentUUID)

  if (!projectUUID || !serverUUID || !environmentName) {
    const config = await findProjectConfig(deps.directory)
    if (config) {
      projectUUID ??= config.projectUUID
      serverUUID ??= config.serverUUID
      environmentName ??= config.environmentName
    }
  }

  if (!projectUUID || !serverUUID || !environmentName) {
    // The application knows its own project, environment, and server. A lookup
    // failure here should degrade to the "provide placement" guidance rather
    // than surfacing as an opaque error.
    const target = await resolveTarget(deps, input?.applicationUUID, context.signal).catch(() => undefined)
    if (target) {
      const application = await getApplication(client, target, context.signal).catch(() => undefined)
      if (application) {
        projectUUID ??= application.project_uuid
        serverUUID ??= application.server_uuid
        environmentName ??= application.environment_name
      }
    }
  }

  if (!projectUUID || !serverUUID) return undefined

  // Coolify wants the environment UUID too when it can be resolved.
  if (!environmentUUID && environmentName) {
    const environments = await listEnvironments(client, projectUUID, context.signal).catch(() => [])
    const match = environments.find((environment) => environment.name === environmentName)
    environmentUUID = match?.uuid ?? match?.name
  }

  if (!environmentName && environmentUUID) environmentName = environmentUUID

  return {
    projectUUID,
    serverUUID,
    ...(environmentName === undefined ? {} : { environmentName }),
    ...(environmentUUID === undefined ? {} : { environmentUUID }),
  }
}

export function asApplicationMap(
  value: unknown,
): Record<string, { applicationUUID: string; path?: string; name?: string }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const result: Record<string, { applicationUUID: string; path?: string; name?: string }> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      result[key] = { applicationUUID: entry }
      continue
    }
    const fields = (entry ?? {}) as Record<string, unknown>
    const uuid = fields.applicationUUID ?? fields.application_uuid ?? fields.uuid
    if (typeof uuid !== "string" || uuid === "") continue
    result[key] = {
      applicationUUID: uuid,
      ...(typeof fields.path === "string" && fields.path !== "" ? { path: fields.path } : {}),
      ...(typeof fields.name === "string" && fields.name !== "" ? { name: fields.name } : {}),
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function asDatabaseMap(
  value: unknown,
): Record<string, { databaseUUID?: string; type?: string; name?: string; path?: string }> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const result: Record<string, { databaseUUID?: string; type?: string; name?: string; path?: string }> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      result[key] = { databaseUUID: entry }
      continue
    }
    const fields = (entry ?? {}) as Record<string, unknown>
    const uuid = fields.databaseUUID ?? fields.database_uuid ?? fields.uuid
    const type = fields.type
    const built: { databaseUUID?: string; type?: string; name?: string; path?: string } = {
      ...(typeof uuid === "string" && uuid !== "" ? { databaseUUID: uuid } : {}),
      ...(typeof type === "string" && type !== "" ? { type } : {}),
      ...(typeof fields.name === "string" && fields.name !== "" ? { name: fields.name } : {}),
      ...(typeof fields.path === "string" && fields.path !== "" ? { path: fields.path } : {}),
    }
    if (Object.keys(built).length > 0) result[key] = built
  }
  return Object.keys(result).length > 0 ? result : undefined
}
