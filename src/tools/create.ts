import { readdir, readFile, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path"
import { findProjectConfig, updateProjectConfig, type ProjectConfig } from "../project-config"
import {
  MISSING_CREDENTIAL,
  WITH_ENDPOINT,
  requireString,
  resolvePlacement,
  type ToolDeps,
  type ToolResult,
  type ToolSpec,
} from "./shared"

const SOURCES = ["public", "private_deploy_key", "private_github_app", "dockerfile", "dockerimage"] as const
type Source = (typeof SOURCES)[number]

interface PackageInspection {
  /** Repo-relative directory the app is built from, in Coolify's `/apps/api` form. */
  readonly baseDirectory: string
  readonly buildPack: "dockercompose" | "dockerfile" | "nixpacks"
  readonly dockerfileLocation?: string
  readonly dockerComposeLocation?: string
  readonly portsExposes?: string
  /** Why the proposal looks like this, for the user to check. */
  readonly reasons: readonly string[]
  readonly hasPackageJson: boolean
}

/**
 * Inspect a checkout and propose build settings.
 *
 * Deterministic and server-side rather than asking the model to guess: a wrong
 * `ports_exposes` produces a deployment that succeeds and then serves 502s,
 * which is the most common Coolify failure.
 */
export async function inspectPackage(directory: string, basePath: string): Promise<PackageInspection> {
  const baseDirectory = basePath === "" || basePath === "/" ? "/" : `/${basePath.replace(/^\/+|\/+$/g, "")}`
  const absolute = baseDirectory === "/" ? directory : join(directory, baseDirectory)

  const reasons: string[] = []
  let entries: string[] = []
  try {
    entries = await readdir(absolute)
  } catch {
    reasons.push(`could not read ${baseDirectory}; defaulting to nixpacks`)
    return { baseDirectory, buildPack: "nixpacks", reasons, hasPackageJson: false }
  }

  const has = (name: string) => entries.includes(name)
  const packageJson = has("package.json")

  // A compose file wins: it describes the whole stack, including ports.
  for (const compose of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
    if (!has(compose)) continue
    reasons.push(`found ${compose}`)
    const ports = await portsFromCompose(join(absolute, compose))
    if (ports) reasons.push(`ports published in ${compose}: ${ports}`)
    return {
      baseDirectory,
      buildPack: "dockercompose",
      dockerComposeLocation: `${baseDirectory === "/" ? "" : baseDirectory}/${compose}`,
      ...(ports ? { portsExposes: ports } : {}),
      reasons,
      hasPackageJson: packageJson,
    }
  }

  for (const dockerfile of ["Dockerfile", "dockerfile"]) {
    if (!has(dockerfile)) continue
    reasons.push(`found ${dockerfile}`)
    const location = `${baseDirectory === "/" ? "" : baseDirectory}/${dockerfile}`
    const ports = await portsFromDockerfile(join(absolute, dockerfile))
    if (ports) reasons.push(`EXPOSE in ${dockerfile}: ${ports}`)
    else reasons.push(`${dockerfile} declares no EXPOSE; confirm the port with the user`)
    return {
      baseDirectory,
      buildPack: "dockerfile",
      dockerfileLocation: location,
      ...(ports ? { portsExposes: ports } : {}),
      reasons,
      hasPackageJson: packageJson,
    }
  }

  reasons.push(
    packageJson
      ? "no Dockerfile or compose file, so nixpacks will detect the project"
      : "no Dockerfile, compose file, or package.json found",
  )
  return { baseDirectory, buildPack: "nixpacks", reasons, hasPackageJson: packageJson }
}

async function portsFromDockerfile(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8")
    const exposed = [...content.matchAll(/^\s*EXPOSE\s+(.+)$/gim)]
      .flatMap((match) => (match[1] ?? "").split(/\s+/))
      .map((token) => token.replace(/\/.*$/, "").trim())
      .filter((token) => /^\d+$/.test(token))
    return exposed.length > 0 ? [...new Set(exposed)].join(",") : undefined
  } catch {
    return undefined
  }
}

async function portsFromCompose(path: string): Promise<string | undefined> {
  try {
    const content = await readFile(path, "utf8")
    // Deliberately shallow: this is a hint for the user to confirm, not a parser.
    const published = [...content.matchAll(/-\s*["']?(\d+):\d+["']?/g)].map((match) => match[1]!).filter(Boolean)
    return published.length > 0 ? [...new Set(published)].join(",") : undefined
  } catch {
    return undefined
  }
}

/** Propose an application, without creating anything. */
export function planApplicationTool(deps: ToolDeps): ToolSpec {
  return {
    name: "plan_application",
    tier: "read",
    description:
      "Inspect this repository and propose the Coolify build settings for it: build pack, exposed port, base directory for a monorepo package, and the Dockerfile or compose location. Read-only — show the proposal to the user, agree any correction, then call coolify_create_application with the confirmed values.",
    input: {
      type: "object",
      properties: {
        applicationUUID: { type: "string", description: "Propose for the directory this application maps to." },
      },
      additionalProperties: false,
    },
    async run(input): Promise<ToolResult> {
      const basePath = await mappedPath(deps, input?.applicationUUID)
      const inspection = await inspectPackage(deps.directory, basePath)

      const lines = [
        `Base directory: ${inspection.baseDirectory}${basePath ? " (from coolify.json)" : ""}`,
        `Build pack: ${inspection.buildPack}`,
        inspection.dockerfileLocation ? `Dockerfile: ${inspection.dockerfileLocation}` : "",
        inspection.dockerComposeLocation ? `Compose file: ${inspection.dockerComposeLocation}` : "",
        inspection.portsExposes
          ? `Exposed port: ${inspection.portsExposes}`
          : "Exposed port: unknown — ask the user, do not guess",
        "",
        "Why:",
        ...inspection.reasons.map((reason) => `- ${reason}`),
        "",
        "Show this to the user before creating anything. Confirm the port especially: a wrong port deploys successfully and then serves 502s.",
      ].filter(Boolean)

      return {
        content: lines.join("\n"),
        metadata: {
          baseDirectory: inspection.baseDirectory,
          buildPack: inspection.buildPack,
          portsExposes: inspection.portsExposes,
        },
      }
    },
  }
}

/** Create an application, and record it in coolify.json straight away. */
export function createApplicationTool(deps: ToolDeps): ToolSpec {
  return {
    name: "create_application",
    tier: "write",
    description: `Create a Coolify application, then record it in coolify.json. This provisions real infrastructure, so agree the plan with the user first (coolify_plan_application) and never invent a UUID for a credential.

Sources:
- public: a public git repository.
- private_deploy_key: private repository using an existing private key (privateKeyUUID).
- private_github_app: private repository using an existing GitHub App (githubAppUUID).
- dockerfile: an application from a Dockerfile body, with no repository.
- dockerimage: an application from a prebuilt image.

Placement is taken from coolify.json or the linked application when not given. The token's team must be able to see the chosen server.`,
    input: {
      type: "object",
      properties: {
        source: { type: "string", enum: [...SOURCES] },
        name: { type: "string" },
        projectUUID: { type: "string" },
        environmentName: { type: "string" },
        environmentUUID: { type: "string" },
        serverUUID: { type: "string" },
        destinationUUID: { type: "string" },
        gitRepository: { type: "string" },
        gitBranch: { type: "string" },
        buildPack: { type: "string", enum: ["nixpacks", "railpack", "static", "dockerfile", "dockercompose"] },
        portsExposes: { type: "string" },
        baseDirectory: { type: "string" },
        domains: { type: "string" },
        dockerfile: { type: "string", description: "dockerfile source: the Dockerfile body." },
        dockerfileLocation: { type: "string" },
        dockerComposeLocation: { type: "string" },
        dockerRegistryImageName: { type: "string", description: "dockerimage source." },
        dockerRegistryImageTag: { type: "string" },
        instantDeploy: { type: "boolean", description: "Deploy immediately. Default false so creation and deploy stay separate." },
        privateKeyUUID: { type: "string", description: "private_deploy_key source." },
        githubAppUUID: { type: "string", description: "private_github_app source." },
        record: { type: "boolean", description: "Record the new application in coolify.json. Default true." },
      },
      required: ["source"],
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      const source = input?.source
      if (!SOURCES.includes(source)) {
        return { content: `Unknown source \`${source}\`. Choose one of: ${SOURCES.join(", ")}.` }
      }

      const placement = await resolvePlacement(deps, input, context)
      if (!placement) {
        return {
          content: [
            "Cannot determine where to create the application.",
            "Provide `projectUUID` and `serverUUID`, or link an existing application (or add them to coolify.json).",
          ].join("\n"),
        }
      }

      const inspection = await inspectPackage(deps.directory, nonEmpty(input?.baseDirectory) ?? (await mappedPath(deps, undefined)))
      const baseDirectory = nonEmpty(input?.baseDirectory) ?? inspection.baseDirectory
      const buildPack = nonEmpty(input?.buildPack) ?? inspection.buildPack
      const ports = nonEmpty(input?.portsExposes) ?? inspection.portsExposes

      if (source !== "dockerimage" && source !== "dockerfile" && !ports) {
        return {
          content: [
            "No exposed port could be inferred and none was given.",
            "Coolify requires ports_exposes for a git-based application, and a wrong guess produces a deployment that serves 502s.",
            "Call coolify_plan_application, then confirm the port with the user.",
          ].join("\n"),
        }
      }

      const body: Record<string, unknown> = {
        project_uuid: placement.projectUUID,
        server_uuid: placement.serverUUID,
        ...(placement.environmentUUID === undefined ? {} : { environment_uuid: placement.environmentUUID }),
        ...(placement.environmentName === undefined ? {} : { environment_name: placement.environmentName }),
        ...(nonEmpty(input?.name) === undefined ? {} : { name: input.name }),
        ...(nonEmpty(input?.destinationUUID) === undefined ? {} : { destination_uuid: input.destinationUUID }),
        ...(nonEmpty(input?.domains) === undefined ? {} : { domains: input.domains }),
        ...(baseDirectory === "/" ? {} : { base_directory: baseDirectory }),
        ...(input?.instantDeploy === true ? { instant_deploy: true } : {}),
      }

      let path: string
      if (source === "public" || source === "private_deploy_key" || source === "private_github_app") {
        const gitRepository = requireString(input, "gitRepository")
        const gitBranch = nonEmpty(input?.gitBranch) ?? "main"
        Object.assign(body, {
          git_repository: gitRepository,
          git_branch: gitBranch,
          build_pack: buildPack,
          ports_exposes: ports ?? "",
          ...(nonEmpty(input?.dockerfileLocation) === undefined ? {} : { dockerfile_location: input.dockerfileLocation }),
          ...(nonEmpty(input?.dockerComposeLocation) === undefined
            ? {}
            : { docker_compose_location: input.dockerComposeLocation }),
        })
        path =
          source === "public"
            ? "/applications/public"
            : source === "private_deploy_key"
              ? "/applications/private-deploy-key"
              : "/applications/private-github-app"
        if (source === "private_deploy_key") body.private_key_uuid = requireString(input, "privateKeyUUID")
        if (source === "private_github_app") body.github_app_uuid = requireString(input, "githubAppUUID")
      } else if (source === "dockerfile") {
        Object.assign(body, { dockerfile: requireString(input, "dockerfile"), ports_exposes: ports ?? "" })
        path = "/applications/dockerfile"
      } else {
        Object.assign(body, {
          docker_registry_image_name: requireString(input, "dockerRegistryImageName"),
          ...(nonEmpty(input?.dockerRegistryImageTag) === undefined
            ? {}
            : { docker_registry_image_tag: input.dockerRegistryImageTag }),
          ports_exposes: ports ?? "",
        })
        path = "/applications/dockerimage"
      }

      const created = await client.request<{ uuid?: string }>({
        method: "POST",
        path,
        body,
        requires: "write",
        signal: context.signal,
      })

      const uuid = created?.uuid
      const lines = [
        `Created application${uuid ? ` ${uuid}` : ""} from source \`${source}\`.`,
        `Placement: project ${placement.projectUUID}${placement.environmentName ? ` · ${placement.environmentName}` : ""} · server ${placement.serverUUID}`,
        `Build: ${buildPack}${ports ? ` · port ${ports}` : ""}${baseDirectory === "/" ? "" : ` · base ${baseDirectory}`}`,
        input?.instantDeploy === true ? "Deployment started." : "Not deployed yet — call coolify_deploy when ready.",
      ]

      if (uuid && input?.record !== false) {
        try {
          const file = await configFileFor(deps.directory)
          const config = await findProjectConfig(deps.directory)
          const key = applicationKey(config, uuid, baseDirectory, nonEmpty(input?.name))
          await updateProjectConfig(file, {
            projectUUID: placement.projectUUID,
            ...(placement.environmentName ? { environmentName: placement.environmentName } : {}),
            applications: {
              [key]: {
                applicationUUID: uuid,
                ...(baseDirectory === "/" ? {} : { path: baseDirectory.replace(/^\//, "") }),
                ...(nonEmpty(input?.name) === undefined ? {} : { name: input.name }),
              },
            },
          })
          lines.push(`Recorded it in ${file} as \`${key}\`. Commit that file so the mapping is shared.`)
          deps.emitProjectChanged(file)
        } catch (cause) {
          // The resource exists, so the UUID must not be lost just because the
          // mapping could not be written.
          lines.push(
            `Created, but could NOT record it in coolify.json: ${cause instanceof Error ? cause.message : String(cause)}.`,
            `Application UUID: ${uuid} — record it manually so it is not lost.`,
          )
        }
      }

      return { content: lines.join("\n"), metadata: { applicationUUID: uuid, source, baseDirectory, buildPack, ports } }
    },
  }
}

/** Where coolify.json lives: an existing one anywhere up the tree, else the repo root. */
export async function configFileFor(directory: string): Promise<string> {
  const existing = await findProjectConfig(directory)
  if (existing) return existing.file
  return join(await repoRoot(directory), "coolify.json")
}

async function repoRoot(directory: string): Promise<string> {
  let current = resolvePath(directory)
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      await stat(join(current, ".git"))
      return current
    } catch {
      const parent = resolvePath(current, "..")
      if (parent === current) return current
      current = parent
    }
  }
  return current
}

/**
 * A stable key for the `applications` map: the package directory's basename,
 * falling back to a path slug when that name is already taken by another
 * application.
 */
export function applicationKey(
  config: ProjectConfig | undefined,
  applicationUUID: string,
  baseDirectory: string,
  name: string | undefined,
): string {
  const existing = config?.applications ?? {}
  const takenBy = (key: string) => {
    const entry = existing[key]
    return entry !== undefined && entry.applicationUUID !== applicationUUID
  }

  const path = baseDirectory.replace(/^\/+|\/+$/g, "")
  const candidates = [
    path === "" ? "" : (path.split("/").pop() ?? ""),
    path.replace(/\//g, "-"),
    slug(name ?? ""),
    "application",
  ].filter((candidate) => candidate !== "")

  for (const candidate of candidates) {
    const key = slug(candidate)
    if (key !== "" && !takenBy(key)) return key
  }
  return slug(applicationUUID) || "application"
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

/** The package directory this project maps to, if coolify.json says so. */
async function mappedPath(deps: ToolDeps, applicationUUID: unknown): Promise<string> {
  const config = await findProjectConfig(deps.directory)
  if (!config) return ""
  const entries = Object.entries(config.applications)
  if (typeof applicationUUID === "string" && applicationUUID !== "") {
    const match = entries.find(([, entry]) => entry.applicationUUID === applicationUUID)
    return match?.[1].path ?? ""
  }
  // Prefer the entry that owns the working directory.
  const relativeDirectory = relative(config.directory, deps.directory).split("\\").join("/")
  const owned = entries
    .filter(([, entry]) => entry.path && (relativeDirectory === entry.path || relativeDirectory.startsWith(`${entry.path}/`)))
    .sort((left, right) => (right[1].path ?? "").length - (left[1].path ?? "").length)
  return owned[0]?.[1].path ?? ""
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}
