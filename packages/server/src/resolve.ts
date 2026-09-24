import { readFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path"
import type { CoolifyClient } from "./coolify/client"
import { listApplications } from "./coolify/resources"
import { granted, type CapabilityReport, type CoolifyApplication } from "./coolify/types"
import {
  databasesFor,
  findProjectConfig,
  selectApplication,
  type ProjectConfig,
  type ProjectConfigDatabase,
} from "./project-config"
import { readLink, type LinkSource, type ResolvedLink, type StorageLike } from "./store"

export interface ResolutionCandidate {
  readonly applicationUUID: string
  readonly name: string
  readonly gitRepository?: string
  readonly domains?: string
  readonly projectUUID?: string
  readonly environmentName?: string
  readonly serverUUID?: string
  readonly score: number
  readonly reasons: readonly string[]
}

/** A condensed view of `coolify.json`, surfaced so the model can reason about a monorepo. */
export interface ProjectConfigSummary {
  readonly file: string
  readonly relativeFile: string
  readonly projectUUID?: string
  readonly environmentName?: string
  readonly serverUUID?: string
  readonly selected?: {
    readonly key: string
    readonly applicationUUID: string
    readonly path?: string
    readonly reason: string
  }
  readonly applications: Readonly<Record<string, { readonly applicationUUID: string; readonly path?: string }>>
  readonly databases: Readonly<Record<string, ProjectConfigDatabase>>
}

export interface Resolution {
  readonly source: "config" | "pin" | "discovered" | "none"
  /**
   * True when the project is a monorepo and more than one application could
   * apply, so the plugin refuses to choose without being told.
   */
  readonly ambiguous: boolean
  readonly best?: ResolutionCandidate
  readonly candidates: readonly ResolutionCandidate[]
  readonly link?: ResolvedLink
  readonly config?: ProjectConfigSummary
  readonly notes: readonly string[]
}

export interface ResolveInput {
  readonly store: StorageLike
  readonly projectID: string
  readonly directory: string
  readonly client: CoolifyClient | undefined
  readonly capabilities: CapabilityReport | undefined
  readonly signal?: AbortSignal
}

const CONFIDENT_SCORE = 60

/**
 * Score for a candidate that came from explicit intent rather than matching.
 * Kept finite because RPC outputs are validated as JSON, and `Infinity` is not
 * a JSON value.
 */
const PINNED_SCORE = 1_000

/**
 * Find the Coolify application that already deploys this project.
 *
 * Order of precedence:
 *   1. `coolify.json` — committed, shared, and monorepo-aware. It wins because
 *      a checked-in mapping is the one everybody on the team gets.
 *   2. a link pinned through the plugin — a local, per-machine override.
 *   3. discovery against the Coolify API, ranked by git remote then name.
 *
 * Discovery needs the `read` ability. With a deploy-only token only 1 and 2 can
 * succeed, which is exactly why they are checked first.
 */
export async function resolveProject(input: ResolveInput): Promise<Resolution> {
  const notes: string[] = []

  const config = await findProjectConfig(input.directory)
  const summary = config ? summarize(config, input.directory) : undefined

  if (config) {
    const selected = selectApplication(config, input.directory)
    if (selected) {
      const candidate = configCandidate(config, selected, input.directory)
      return {
        source: "config",
        ambiguous: false,
        best: candidate,
        candidates: [candidate],
        link: linkFromConfig(config, selected),
        config: { ...summary!, selected: { key: selected.key, applicationUUID: selected.applicationUUID, ...(selected.path === undefined ? {} : { path: selected.path }), reason: selected.reason } },
        notes: [
          ...notes,
          `Using \`${summary!.relativeFile}\` (${selected.reason}).`,
        ],
      }
    }

    // A monorepo config that does not cover this directory must not fall through
    // to fuzzy discovery: guessing here could link the wrong package's app.
    const entries = Object.entries(config.applications)
    if (entries.length > 1) {
      return {
        source: "none",
        ambiguous: true,
        candidates: entries.map(([key, entry]) => configCandidateForKey(config, key, entry, input.directory)),
        config: summary,
        notes: [
          ...notes,
          `\`${summary!.relativeFile}\` lists ${entries.length} applications and none owns this directory. Ask which one applies, then name its key or path.`,
        ],
      }
    }
  }

  const pinned = await readLink(input.store, input.projectID)
  if (pinned) {
    const verified = await verify(input.client, pinned, input.signal)
    if (verified.ok) {
      return {
        source: "pin",
        ambiguous: false,
        best: candidateFromLink(pinned, verified.application, ["pinned through the plugin"]),
        candidates: [candidateFromLink(pinned, verified.application, ["pinned through the plugin"])],
        link: pinned,
        ...(summary ? { config: summary } : {}),
        notes: [...notes, `Using the application pinned for this project (${pinned.source}).`],
      }
    }
    notes.push(
      verified.reason === "missing"
        ? `The pinned application ${pinned.applicationUUID} no longer exists on Coolify; falling back to discovery.`
        : `Could not verify the pinned application: ${verified.reason}. Falling back to discovery.`,
    )
  }

  if (!input.client) {
    return {
      source: "none",
      ambiguous: false,
      candidates: [],
      ...(summary ? { config: summary } : {}),
      notes: [...notes, "No Coolify client is configured, so discovery was skipped."],
    }
  }
  if (!granted(input.capabilities, "read")) {
    return {
      source: "none",
      ambiguous: false,
      candidates: [],
      ...(summary ? { config: summary } : {}),
      notes: [
        ...notes,
        "The token lacks the `read` ability, so applications cannot be listed. Add a `coolify.json` with the application UUID.",
      ],
    }
  }

  const gitRemote = await readGitRemote(input.directory)
  const projectName = basename(input.directory)
  const applications = await listApplications(input.client, input.signal)
  const candidates = rank(applications, { gitRemote, projectName })

  if (candidates.length === 0) {
    return {
      source: "none",
      ambiguous: false,
      candidates: [],
      ...(summary ? { config: summary } : {}),
      notes: [...notes, "No Coolify application matched this project's git remote or directory name."],
    }
  }

  const best = candidates[0]!
  const ambiguous = candidates.length > 1 && candidates[1]!.score === best.score
  const confident = !ambiguous && best.score >= CONFIDENT_SCORE

  return {
    source: confident ? "discovered" : "none",
    ambiguous,
    ...(confident ? { best } : {}),
    candidates,
    ...(summary ? { config: summary } : {}),
    notes: [
      ...notes,
      ambiguous
        ? "Several applications matched equally well; ask the user to choose."
        : confident
          ? `Matched by ${best.reasons.join(" and ")}.`
          : "Only weak matches were found; confirm the choice with the user.",
    ],
  }
}

function summarize(config: ProjectConfig, directory: string): ProjectConfigSummary {
  return {
    file: config.file,
    relativeFile: displayPath(config.file, directory),
    ...(config.projectUUID === undefined ? {} : { projectUUID: config.projectUUID }),
    ...(config.environmentName === undefined ? {} : { environmentName: config.environmentName }),
    ...(config.serverUUID === undefined ? {} : { serverUUID: config.serverUUID }),
    applications: config.applications,
    databases: databasesFor(config, directory),
  }
}

function configCandidate(
  config: ProjectConfig,
  selected: { key: string; applicationUUID: string; path?: string; name?: string; reason: string },
  directory: string,
): ResolutionCandidate {
  return {
    applicationUUID: selected.applicationUUID,
    name: selected.name ?? selected.key,
    ...(config.projectUUID === undefined ? {} : { projectUUID: config.projectUUID }),
    ...(config.environmentName === undefined ? {} : { environmentName: config.environmentName }),
    ...(config.serverUUID === undefined ? {} : { serverUUID: config.serverUUID }),
    score: PINNED_SCORE,
    reasons: [`coolify.json · ${selected.reason}`],
  }
}

function configCandidateForKey(
  config: ProjectConfig,
  key: string,
  entry: { applicationUUID: string; path?: string; name?: string },
  directory: string,
): ResolutionCandidate {
  return {
    applicationUUID: entry.applicationUUID,
    name: entry.name ?? key,
    ...(config.projectUUID === undefined ? {} : { projectUUID: config.projectUUID }),
    ...(config.environmentName === undefined ? {} : { environmentName: config.environmentName }),
    ...(config.serverUUID === undefined ? {} : { serverUUID: config.serverUUID }),
    score: 0,
    reasons: [`coolify.json key "${key}"${entry.path ? ` · path ${entry.path}` : ""}`],
  }
}

function linkFromConfig(
  config: ProjectConfig,
  selected: { applicationUUID: string; name?: string },
): ResolvedLink {
  return {
    applicationUUID: selected.applicationUUID,
    ...(config.projectUUID === undefined ? {} : { projectUUID: config.projectUUID }),
    ...(config.environmentName === undefined ? {} : { environmentName: config.environmentName }),
    ...(config.serverUUID === undefined ? {} : { serverUUID: config.serverUUID }),
    ...(selected.name === undefined ? {} : { name: selected.name }),
    linkedAt: Date.now(),
    source: "config",
  }
}

function displayPath(file: string, directory: string): string {
  const rel = relative(directory, file)
  if (rel !== "" && !rel.startsWith("..")) return rel
  // Escaping the directory (`../../coolify.json` in a monorepo) is noise, so
  // fall back to the file's own name.
  return file.split("/").pop() ?? file
}

/** Build a link to persist once the user confirms a candidate. */
export function linkCandidate(application: CoolifyApplication, source: LinkSource): ResolvedLink {
  return {
    applicationUUID: application.uuid,
    ...(application.project_uuid === undefined ? {} : { projectUUID: application.project_uuid }),
    ...(application.environment_name === undefined ? {} : { environmentName: application.environment_name }),
    ...(application.server_uuid === undefined ? {} : { serverUUID: application.server_uuid }),
    ...(application.name === undefined ? {} : { name: application.name }),
    ...(application.git_repository === undefined ? {} : { gitRepository: application.git_repository }),
    linkedAt: Date.now(),
    source,
  }
}

function candidateFromLink(
  link: ResolvedLink,
  application: CoolifyApplication | undefined,
  reasons: readonly string[],
): ResolutionCandidate {
  return {
    applicationUUID: link.applicationUUID,
    name: application?.name ?? link.name ?? link.applicationUUID,
    ...(application?.git_repository ?? link.gitRepository) === undefined
      ? {}
      : { gitRepository: application?.git_repository ?? link.gitRepository },
    ...(application?.fqdn ? { domains: application.fqdn } : {}),
    ...(application?.project_uuid ?? link.projectUUID) === undefined
      ? {}
      : { projectUUID: application?.project_uuid ?? link.projectUUID },
    ...(application?.environment_name ?? link.environmentName) === undefined
      ? {}
      : { environmentName: application?.environment_name ?? link.environmentName },
    ...(application?.server_uuid ?? link.serverUUID) === undefined
      ? {}
      : { serverUUID: application?.server_uuid ?? link.serverUUID },
    score: PINNED_SCORE,
    reasons,
  }
}

async function verify(
  client: CoolifyClient | undefined,
  link: ResolvedLink,
  signal?: AbortSignal,
): Promise<{ ok: true; application?: CoolifyApplication } | { ok: false; reason: string }> {
  if (!client) return { ok: true }
  try {
    const application = await client.request<CoolifyApplication>({
      method: "GET",
      path: `/applications/${link.applicationUUID}`,
      requires: "read",
      signal,
    })
    return { ok: true, application }
  } catch (error) {
    const kind = error && typeof error === "object" && "kind" in error ? (error as { kind: string }).kind : "unknown"
    if (kind === "not_found") return { ok: false, reason: "missing" }
    if (kind === "forbidden" || kind === "missing_sensitive") return { ok: true }
    return { ok: false, reason: kind }
  }
}

function rank(
  applications: readonly CoolifyApplication[],
  context: { gitRemote: string | undefined; projectName: string },
): ResolutionCandidate[] {
  const wantedName = normalizeName(context.projectName)

  const candidates = applications.map((application) => {
    const reasons: string[] = []
    let score = 0

    if (context.gitRemote && application.git_repository) {
      const match = matchGitRepository(application.git_repository, context.gitRemote)
      if (match === "exact") {
        score += 100
        reasons.push("git remote")
      } else if (match === "path") {
        score += 80
        reasons.push("git repository path")
      }
    }

    const applicationName = normalizeName(application.name ?? "")
    if (applicationName !== "" && applicationName === wantedName) {
      score += 60
      reasons.push("name")
    } else if (applicationName !== "" && (applicationName.includes(wantedName) || wantedName.includes(applicationName))) {
      score += 25
      reasons.push("partial name")
    }

    const candidate: ResolutionCandidate = {
      applicationUUID: application.uuid,
      name: application.name ?? application.uuid,
      ...(application.git_repository === undefined ? {} : { gitRepository: application.git_repository }),
      ...(application.fqdn ? { domains: application.fqdn } : {}),
      ...(application.project_uuid === undefined ? {} : { projectUUID: application.project_uuid }),
      ...(application.environment_name === undefined ? {} : { environmentName: application.environment_name }),
      ...(application.server_uuid === undefined ? {} : { serverUUID: application.server_uuid }),
      score,
      reasons,
    }
    return candidate
  })

  return candidates
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
}

/**
 * Read `remote.origin.url` from the repository config.
 *
 * Handles both a normal `.git/config` and a worktree's `.git` file, which
 * contains a `gitdir:` pointer to the real git directory.
 */
export async function readGitRemote(directory: string): Promise<string | undefined> {
  const gitPath = join(directory, ".git")
  let configPath = join(gitPath, "config")
  try {
    const pointer = await readFile(gitPath, "utf8")
    const match = pointer.match(/^gitdir:\s*(.+)$/m)
    if (match?.[1]) {
      const gitDir = isAbsolute(match[1]) ? match[1] : resolvePath(directory, match[1])
      configPath = join(gitDir, "config")
    }
  } catch {
    // `.git` is a directory, or there is no repository here.
  }

  try {
    const config = await readFile(configPath, "utf8")
    const remote = config.match(/\[remote\s+"origin"\]([\s\S]*?)(?:\n\[|$)/)
    const url = remote?.[1]?.match(/^\s*url\s*=\s*(.+)$/m)
    return url?.[1]?.trim()
  } catch {
    return undefined
  }
}

/** Normalize the common git URL spellings to `host/owner/repo`. */
export function normalizeGitUrl(raw: string): string {
  let value = raw.trim().toLowerCase().replace(/^git\+/, "")
  if (!value.includes("://")) {
    const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(.+)$/)
    if (scp?.[1] && scp[2]) value = `${scp[1]}/${scp[2]}`
  }
  return value
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^@/]*@/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
}

/** The trailing `owner/repo` of a normalized reference. */
export function gitRepoPath(normalized: string): string {
  return normalized.split("/").filter(Boolean).slice(-2).join("/")
}

export type GitMatch = "exact" | "path" | "none"

/**
 * Compare a Coolify `git_repository` against a local remote.
 *
 * Coolify accepts and stores the short `owner/repo` form (used by GitHub App
 * deployments), while a local checkout reports a full URL such as
 * `https://github.com/owner/repo.git`. Exact comparison alone misses that, so a
 * two-segment reference is also matched against the tail of a longer one.
 */
export function matchGitRepository(left: string | undefined, right: string | undefined): GitMatch {
  if (!left || !right) return "none"
  const a = normalizeGitUrl(left)
  const b = normalizeGitUrl(right)
  if (a === "" || b === "") return "none"
  if (a === b) return "exact"

  const segments = (value: string) => value.split("/").filter(Boolean).length
  if (gitRepoPath(a) === gitRepoPath(b) && (segments(a) === 2 || segments(b) === 2)) return "path"
  return "none"
}

export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function basename(directory: string): string {
  return directory.replace(/\/+$/, "").split("/").pop() ?? directory
}
