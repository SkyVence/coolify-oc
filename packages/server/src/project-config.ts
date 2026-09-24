import type { Dirent } from "node:fs"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve as resolvePath } from "node:path"

/**
 * The repo-level `coolify.json`.
 *
 * This file is the source of truth for which Coolify resources a repository —
 * and, in a monorepo, each package inside it — maps to. It is meant to be
 * committed, so the mapping is shared rather than living in one person's local
 * plugin storage.
 *
 * ```jsonc
 * {
 *   "projectUUID": "proj_uuid",
 *   "environmentName": "production",
 *   "serverUUID": "srv_uuid",
 *   // Single-app repositories can use the shorthand.
 *   "applicationUUID": "app_uuid",
 *   // Monorepos name each app, keyed by a stable label, with the path it owns.
 *   "applications": {
 *     "web": { "applicationUUID": "web_uuid", "path": "apps/web" },
 *     "api": { "applicationUUID": "api_uuid", "path": "apps/api", "name": "acme-api" }
 *   },
 *   "databases": {
 *     "postgres": { "databaseUUID": "db_uuid", "type": "postgresql" }
 *   }
 * }
 * ```
 *
 * `coolify.json` is tried first, then `.coolify.json` for compatibility with
 * what this plugin used before and with the filename the official CLI has
 * proposed in coollabsio/coolify-cli#85.
 */
export interface ProjectConfigApplication {
  readonly applicationUUID: string
  /** Repo-relative directory this app owns, used to pick in a monorepo. */
  readonly path?: string
  /** Human label when it differs from the map key. */
  readonly name?: string
}

export interface ProjectConfigDatabase {
  readonly databaseUUID?: string
  readonly type?: string
  readonly name?: string
  /** Repo-relative directory whose app uses this database, when scoped. */
  readonly path?: string
}

export interface ProjectConfig {
  /** Absolute path of the file this was read from. */
  readonly file: string
  /** Directory the config's relative `path` values are resolved against. */
  readonly directory: string
  readonly projectUUID?: string
  readonly environmentName?: string
  readonly serverUUID?: string
  /** Shorthand for a single-application repository. */
  readonly applicationUUID?: string
  readonly applications: Readonly<Record<string, ProjectConfigApplication>>
  readonly databases: Readonly<Record<string, ProjectConfigDatabase>>
}

export const CONFIG_FILENAMES = ["coolify.json", ".coolify.json"] as const

/**
 * Why a pasted config cannot be used, or `undefined` when it is usable.
 *
 * Deliberately shallow: it checks the file has the right shape, not that every
 * UUID exists on the instance. Whether a UUID is real is what `coolify_resolve`
 * reports, and inventing one is a mistake the caller can still make — but a
 * config with no application at all would leave the sidebar silently unable to
 * resolve anything, which is worse than refusing the write.
 */
export function validateProjectJson(record: Record<string, unknown>): string | undefined {
  const applications = record.applications
  const single = record.applicationUUID
  const project = record.projectUUID
  const hasSingle = typeof single === "string" && single.trim() !== ""
  const hasProject = typeof project === "string" && project.trim() !== ""

  if (applications === undefined && !hasSingle && !hasProject) {
    return "coolify.json needs an `applications` map, an `applicationUUID`, or a `projectUUID`."
  }

  if (applications !== undefined) {
    if (applications === null || typeof applications !== "object" || Array.isArray(applications)) {
      return "`applications` must be an object keyed by name."
    }
    for (const [key, value] of Object.entries(applications as Record<string, unknown>)) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return `\`applications.${key}\` must be an object.`
      }
      const uuid = (value as Record<string, unknown>).applicationUUID
      if (typeof uuid !== "string" || uuid.trim() === "") {
        return `\`applications.${key}.applicationUUID\` must be a non-empty string.`
      }
    }
  }

  const databases = record.databases
  if (databases !== undefined && (databases === null || typeof databases !== "object" || Array.isArray(databases))) {
    return "`databases` must be an object keyed by name."
  }

  return undefined
}


/** A parsed config that has never been written, used when starting from scratch. */
export function emptyProjectConfig(file: string): ProjectConfig {
  return {
    file,
    directory: dirname(file),
    applications: {},
    databases: {},
  }
}

/**
 * Walk up from `from` and return the nearest config.
 *
 * The walk stops after the directory that contains `.git`, so a stray config in
 * a parent directory outside the repository can never be picked up.
 */
export async function findProjectConfig(from: string): Promise<ProjectConfig | undefined> {
  let current = resolvePath(from)

  while (true) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(current, name)
      const config = await tryRead(candidate)
      if (config) return config
    }

    // Stop at the repository root, after checking it.
    if (await hasGitEntry(current)) return undefined

    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function tryRead(file: string): Promise<ProjectConfig | undefined> {
  try {
    return parseProjectConfig(file, await readFile(file, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * True when `directory` holds a VCS marker.
 *
 * `stat` is used rather than reading `.git/HEAD`, because `.git` is a directory
 * in a normal checkout but a file in a worktree, and a freshly initialised
 * repository may not have written `HEAD` yet.
 */
async function hasGitEntry(directory: string): Promise<boolean> {
  for (const name of [".git", ".hg"]) {
    try {
      await stat(join(directory, name))
      return true
    } catch {
      // Not a repository marker.
    }
  }
  return false
}

/** Directory levels below the root searched by `findAllProjectConfigs`. */
const DEFAULT_MAX_CONFIG_DEPTH = 4

/**
 * Directories that never contain a committed config worth showing, or that are
 * too expensive to walk. They can still hold a stray `coolify.json` (vendored
 * sources, build output), so they are skipped explicitly rather than trusted.
 */
const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  "vendor",
])

export interface FindAllProjectConfigsOptions {
  /** Directory levels below `root` to search. Defaults to 4. */
  readonly maxDepth?: number
}

/**
 * Walk DOWN from `root` and collect every `coolify.json` (and `.coolify.json`).
 *
 * Unlike `findProjectConfig`, which stops at the nearest config, this returns
 * the whole tree so a repository can map several projects at once. The walk is
 * depth-bounded and skips the usual build and dependency directories, so it
 * stays cheap even in a big monorepo. Symlinked directories are never followed:
 * `Dirent.isDirectory()` is false for a symlink, so the check below excludes
 * them without a separate `stat`. Malformed files are skipped by reusing
 * `parseProjectConfig` through `tryRead`, so one bad file cannot hide the rest.
 *
 * Results are sorted by absolute path, giving a stable order across runs.
 */
export async function findAllProjectConfigs(
  root: string,
  options: FindAllProjectConfigsOptions = {},
): Promise<ProjectConfig[]> {
  const start = resolvePath(root)
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_CONFIG_DEPTH
  const found: ProjectConfig[] = []

  const visit = async (directory: string, depth: number): Promise<void> => {
    for (const name of CONFIG_FILENAMES) {
      const config = await tryRead(join(directory, name))
      if (config) found.push(config)
    }
    if (depth >= maxDepth) return

    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      // Unreadable directory: nothing more to discover below it.
      return
    }

    const children = entries
      .filter((entry) => entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name))
      .map((entry) => entry.name)
      .sort()

    for (const name of children) {
      await visit(join(directory, name), depth + 1)
    }
  }

  await visit(start, 0)

  return found.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
}

/**
 * Walk up from `from` to the directory holding the VCS marker.
 *
 * Falls back to `from` when there is no marker, so callers always get a
 * directory to scan rather than the filesystem root.
 */
export async function findRepositoryRoot(from: string): Promise<string> {
  const start = resolvePath(from)
  let current = start

  for (;;) {
    if (await hasGitEntry(current)) return current
    const parent = dirname(current)
    if (parent === current) return start
    current = parent
  }
}

export function parseProjectConfig(file: string, raw: string): ProjectConfig {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`)
  }

  return {
    file,
    directory: dirname(file),
    ...stringField("projectUUID", parsed.projectUUID ?? parsed.project_uuid),
    ...stringField("environmentName", parsed.environmentName ?? parsed.environment_name),
    ...stringField("serverUUID", parsed.serverUUID ?? parsed.server_uuid),
    ...stringField("applicationUUID", parsed.applicationUUID ?? parsed.application_uuid),
    applications: parseApplications(parsed.applications),
    databases: parseDatabases(parsed.databases),
  }
}

function parseApplications(value: unknown): Record<string, ProjectConfigApplication> {
  const result: Record<string, ProjectConfigApplication> = {}
  for (const [key, entry] of Object.entries(record(value))) {
    if (typeof entry === "string") {
      result[key] = { applicationUUID: entry }
      continue
    }
    const fields = record(entry)
    const uuid = fields.applicationUUID ?? fields.application_uuid ?? fields.uuid
    if (typeof uuid !== "string" || uuid === "") continue
    result[key] = {
      applicationUUID: uuid,
      ...stringField("path", fields.path),
      ...stringField("name", fields.name),
    }
  }
  return result
}

function parseDatabases(value: unknown): Record<string, ProjectConfigDatabase> {
  const result: Record<string, ProjectConfigDatabase> = {}
  for (const [key, entry] of Object.entries(record(value))) {
    if (typeof entry === "string") {
      result[key] = { databaseUUID: entry }
      continue
    }
    const fields = record(entry)
    const uuid = fields.databaseUUID ?? fields.database_uuid ?? fields.uuid
    result[key] = {
      ...(typeof uuid === "string" && uuid !== "" ? { databaseUUID: uuid } : {}),
      ...stringField("type", fields.type),
      ...stringField("name", fields.name),
      ...stringField("path", fields.path),
    }
  }
  return result
}

export interface SelectedApplication {
  /** Key in the `applications` map, or `"default"` for the shorthand. */
  readonly key: string
  readonly applicationUUID: string
  readonly path?: string
  readonly name?: string
  /** How the match was made, for surfacing to the user. */
  readonly reason: string
}

/**
 * Pick the application that owns `from`.
 *
 * Monorepos are resolved by the longest matching `path` prefix, so a package in
 * `apps/web/admin` still finds the `apps/web` entry. When nothing matches by
 * path the selection falls back to the single-app shorthand, then to a lone
 * `applications` entry, and otherwise stays deliberately unresolved so the
 * caller can ask instead of guessing.
 */
export function selectApplication(config: ProjectConfig, from: string): SelectedApplication | undefined {
  const relativeDirectory = toPosix(relative(config.directory, resolvePath(from)))

  const byPath = Object.entries(config.applications)
    .filter(([, entry]) => entry.path !== undefined && entry.path !== "")
    .map(([key, entry]) => ({ key, entry, path: normalizePath(entry.path!) }))
    .filter(({ path }) => isWithin(relativeDirectory, path))
    .sort((left, right) => right.path.length - left.path.length)

  const best = byPath[0]
  if (best) {
    return {
      key: best.key,
      applicationUUID: best.entry.applicationUUID,
      ...(best.entry.path === undefined ? {} : { path: best.entry.path }),
      ...(best.entry.name === undefined ? {} : { name: best.entry.name }),
      reason: `directory matches \`${best.path}\``,
    }
  }

  if (config.applicationUUID) {
    return { key: "default", applicationUUID: config.applicationUUID, reason: "single-application shorthand" }
  }

  const entries = Object.entries(config.applications)
  if (entries.length === 1) {
    const [key, entry] = entries[0]!
    return {
      key,
      applicationUUID: entry.applicationUUID,
      ...(entry.path === undefined ? {} : { path: entry.path }),
      ...(entry.name === undefined ? {} : { name: entry.name }),
      reason: "the only application in the config",
    }
  }

  return undefined
}

/** Databases scoped to the selected directory, plus unscoped ones. */
export function databasesFor(config: ProjectConfig, from: string): Record<string, ProjectConfigDatabase> {
  const relativeDirectory = toPosix(relative(config.directory, resolvePath(from)))
  const result: Record<string, ProjectConfigDatabase> = {}
  for (const [key, entry] of Object.entries(config.databases)) {
    if (entry.path === undefined || entry.path === "" || isWithin(relativeDirectory, normalizePath(entry.path))) {
      result[key] = entry
    }
  }
  return result
}

export interface ProjectConfigUpdate {
  readonly projectUUID?: string
  readonly environmentName?: string
  readonly serverUUID?: string
  readonly applicationUUID?: string
  readonly applications?: Readonly<Record<string, ProjectConfigApplication>>
  readonly databases?: Readonly<Record<string, ProjectConfigDatabase>>
}

/**
 * Merge an update into `coolify.json`, creating it when absent.
 *
 * Unrecognized top-level keys are preserved, so hand-written comments-as-keys or
 * future fields survive. Map entries merge by key rather than replacing the map.
 */
export async function updateProjectConfig(file: string, update: ProjectConfigUpdate): Promise<ProjectConfig> {
  let existing: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  } catch {
    existing = {}
  }

  const next: Record<string, unknown> = { ...existing }

  for (const key of ["projectUUID", "environmentName", "serverUUID", "applicationUUID"] as const) {
    const value = update[key]
    if (value !== undefined) next[key] = value
  }

  if (update.applications) {
    next.applications = { ...record(existing.applications), ...update.applications }
  }
  if (update.databases) {
    next.databases = { ...record(existing.databases), ...update.databases }
  }

  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  return parseProjectConfig(file, JSON.stringify(next))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringField<Key extends string>(key: Key, value: unknown): Record<Key, string> | Record<string, never> {
  return typeof value === "string" && value !== "" ? ({ [key]: value } as Record<Key, string>) : {}
}

function toPosix(value: string): string {
  const normalized = value.split("\\").join("/")
  return normalized === "" ? "." : normalized
}

export function normalizePath(value: string): string {
  return toPosix(value).replace(/^\.\//, "").replace(/\/+$/, "")
}

/** True when `directory` is `path` or lives inside it. */
export function isWithin(directory: string, path: string): boolean {
  if (path === "" || path === ".") return true
  return directory === path || directory.startsWith(`${path}/`)
}
