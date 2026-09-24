import type { CapabilityReport } from "./coolify/types"

/**
 * The subset of `ctx.storage` this plugin uses. Kept structural so tests can
 * supply an in-memory implementation.
 */
export interface StorageLike {
  get(key: string): Promise<unknown>
  // `any` mirrors the plugin storage signature, which accepts any JSON value.
  set(key: string, value: any): Promise<void>
  remove(key: string): Promise<void>
}

/** How a local project came to be associated with a Coolify application. */
export type LinkSource = "pin" | "config" | "git-remote" | "name"

/** A persisted association between an OpenCode project and a Coolify application. */
export interface ResolvedLink {
  readonly applicationUUID: string
  readonly projectUUID?: string
  readonly environmentName?: string
  readonly serverUUID?: string
  readonly name?: string
  readonly gitRepository?: string
  readonly linkedAt: number
  readonly source: LinkSource
}

const LINK_PREFIX = "link/"
const CAPABILITY_PREFIX = "capabilities/"
const SETTINGS_KEY = "settings"

/**
 * Plugin-scoped settings. Unlike links, these are not per-project: they
 * describe the Coolify instance this plugin talks to.
 */
export interface PluginSettings {
  readonly endpoint?: string
}

export async function readSettings(store: StorageLike): Promise<PluginSettings> {
  const value = await store.get(SETTINGS_KEY)
  if (!value || typeof value !== "object") return {}
  const candidate = value as { endpoint?: unknown }
  return typeof candidate.endpoint === "string" && candidate.endpoint !== "" ? { endpoint: candidate.endpoint } : {}
}

export async function writeSettings(store: StorageLike, settings: PluginSettings): Promise<void> {
  await store.set(SETTINGS_KEY, settings)
}

export function linkKey(projectID: string): string {
  return `${LINK_PREFIX}${projectID}`
}

/**
 * Capabilities are per-instance and per-token, so the cache key includes the
 * endpoint. A cheap FNV-1a hash keeps the key short and filesystem-safe.
 */
export function capabilityKey(endpoint: string): string {
  let hash = 0x811c9dc5
  const normalized = endpoint.toLowerCase()
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${CAPABILITY_PREFIX}${hash.toString(16)}`
}

export async function readLink(store: StorageLike, projectID: string): Promise<ResolvedLink | undefined> {
  return asLink(await store.get(linkKey(projectID)))
}

export async function writeLink(store: StorageLike, projectID: string, link: ResolvedLink): Promise<void> {
  await store.set(linkKey(projectID), link)
}

export async function clearLink(store: StorageLike, projectID: string): Promise<void> {
  await store.remove(linkKey(projectID))
}

export async function readCapabilities(
  store: StorageLike,
  endpoint: string,
): Promise<CapabilityReport | undefined> {
  return asReport(await store.get(capabilityKey(endpoint)))
}

export async function writeCapabilities(
  store: StorageLike,
  report: CapabilityReport,
): Promise<void> {
  await store.set(capabilityKey(report.endpoint), report)
}

function asLink(value: unknown): ResolvedLink | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Partial<ResolvedLink>
  if (typeof candidate.applicationUUID !== "string" || candidate.applicationUUID === "") return undefined
  return {
    applicationUUID: candidate.applicationUUID,
    ...(candidate.projectUUID === undefined ? {} : { projectUUID: candidate.projectUUID }),
    ...(candidate.environmentName === undefined ? {} : { environmentName: candidate.environmentName }),
    ...(candidate.serverUUID === undefined ? {} : { serverUUID: candidate.serverUUID }),
    ...(candidate.name === undefined ? {} : { name: candidate.name }),
    ...(candidate.gitRepository === undefined ? {} : { gitRepository: candidate.gitRepository }),
    linkedAt: typeof candidate.linkedAt === "number" ? candidate.linkedAt : Date.now(),
    source: isLinkSource(candidate.source) ? candidate.source : "pin",
  }
}

function asReport(value: unknown): CapabilityReport | undefined {
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Partial<CapabilityReport>
  if (typeof candidate.endpoint !== "string" || !candidate.probes) return undefined
  return candidate as CapabilityReport
}

function isLinkSource(value: unknown): value is LinkSource {
  return value === "pin" || value === "config" || value === "git-remote" || value === "name"
}
