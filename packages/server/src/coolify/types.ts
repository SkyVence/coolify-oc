/**
 * Coolify API token abilities.
 *
 * Coolify documents these at https://coolify.io/docs/api/permissions. A token
 * is issued with one of `read`, `read:sensitive`, `write`, `deploy`, or `root`.
 * Selecting `root` replaces the others because it bypasses every ability check.
 *
 * There is no endpoint that reports a token's abilities, so the plugin derives
 * them by probing (see `capabilities.ts`) and refines them whenever a request
 * comes back `403`.
 */
export type Capability = "read" | "read:sensitive" | "write" | "deploy"

export const CAPABILITIES = ["read", "read:sensitive", "write", "deploy"] as const satisfies readonly Capability[]

export type ProbeStatus = "granted" | "denied" | "unknown"

export interface CapabilityProbe {
  readonly status: ProbeStatus
  /** Evidence for the verdict: the request that was tried and what came back. */
  readonly detail: string
}

export interface TeamRef {
  readonly id?: string
  readonly name?: string
}

export interface CapabilityReport {
  /** Normalized base URL, including the `/api/v1` suffix. */
  readonly endpoint: string
  /** The team the token is bound to, when it could be read. */
  readonly team?: TeamRef
  readonly probes: Readonly<Record<Capability, CapabilityProbe>>
  /**
   * True when every probed ability was granted, which is what a `root` token
   * produces. `root` can be inferred this way but never confirmed, because
   * Coolify does not expose a token's ability list.
   */
  readonly likelyRoot: boolean
  readonly checkedAt: number
  readonly notes: readonly string[]
}

export const UNKNOWN_PROBE: CapabilityProbe = { status: "unknown", detail: "not probed" }

export function granted(report: CapabilityReport | undefined, capability: Capability): boolean {
  return report?.probes[capability]?.status === "granted"
}

export function denied(report: CapabilityReport | undefined, capability: Capability): boolean {
  return report?.probes[capability]?.status === "denied"
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CoolifyErrorKind =
  | "unauthorized"
  | "forbidden"
  | "missing_sensitive"
  | "not_found"
  | "validation"
  | "rate_limited"
  | "server"
  | "network"
  | "invalid_response"
  | "unknown"

export interface CoolifyErrorInput {
  readonly kind: CoolifyErrorKind
  readonly message: string
  readonly method: string
  readonly path: string
  readonly status?: number
  readonly body?: unknown
  readonly retryAfterSeconds?: number
}

export class CoolifyError extends Error {
  readonly kind: CoolifyErrorKind
  readonly method: string
  readonly path: string
  readonly status: number | undefined
  readonly body: unknown
  readonly retryAfterSeconds: number | undefined

  constructor(input: CoolifyErrorInput) {
    super(input.message)
    this.name = "CoolifyError"
    this.kind = input.kind
    this.method = input.method
    this.path = input.path
    this.status = input.status
    this.body = input.body
    this.retryAfterSeconds = input.retryAfterSeconds
  }
}

/** A short, model-facing sentence describing the failure. */
export function describeError(error: unknown): string {
  if (!(error instanceof CoolifyError)) {
    return error instanceof Error ? error.message : String(error)
  }
  switch (error.kind) {
    case "unauthorized":
      return "Coolify rejected the API token (401). It may be invalid, expired, or revoked."
    case "forbidden":
      return `The Coolify API token is not allowed to perform this operation (403): ${error.method} ${error.path}.`
    case "missing_sensitive":
      return "The Coolify API token lacks the `read:sensitive` ability, so secrets and env values stay redacted."
    case "not_found":
      return `Coolify has no resource at ${error.path}.`
    case "validation":
      return `Coolify rejected the request payload: ${error.message}`
    case "rate_limited":
      return `Coolify rate-limited the request${error.retryAfterSeconds ? `; retry in ${error.retryAfterSeconds}s` : ""}.`
    case "server":
      return `Coolify returned a server error (${error.status}): ${error.message}`
    case "network":
      return error.message
    default:
      return error.message
  }
}

// ---------------------------------------------------------------------------
// Coolify resource shapes (partial: only the fields this plugin relies on)
// ---------------------------------------------------------------------------

export interface CoolifyProject {
  readonly uuid: string
  readonly name: string
  readonly description?: string | null
  readonly [key: string]: unknown
}

export interface CoolifyEnvironment {
  readonly id?: number
  readonly uuid?: string
  readonly name: string
  readonly project_uuid?: string
  readonly [key: string]: unknown
}

export interface CoolifyApplication {
  readonly uuid: string
  readonly name: string
  readonly description?: string | null
  /** Comma-separated domains. */
  readonly fqdn?: string | null
  /** Container state, e.g. `running:healthy`. Parse with `parseApplicationStatus`. */
  readonly status?: string
  readonly git_repository?: string
  readonly git_branch?: string
  readonly git_commit_sha?: string
  readonly build_pack?: string
  readonly project_uuid?: string
  readonly environment_name?: string
  readonly environment_uuid?: string
  readonly server_uuid?: string
  readonly destination_uuid?: string
  readonly [key: string]: unknown
}

export interface CoolifyServer {
  readonly uuid: string
  readonly name: string
  readonly ip?: string
  readonly [key: string]: unknown
}

export interface CoolifyDestination {
  readonly uuid: string
  readonly name?: string
  readonly network?: string
  readonly [key: string]: unknown
}

export interface CoolifyEnvVariable {
  readonly uuid?: string
  readonly key: string
  readonly value?: string
  readonly is_preview?: boolean
  readonly is_literal?: boolean
  readonly is_multiline?: boolean
  readonly is_shown_once?: boolean
  readonly [key: string]: unknown
}

export interface CoolifyDeployment {
  readonly id?: number
  readonly application_id?: string
  readonly deployment_uuid?: string
  readonly application_name?: string
  readonly server_name?: string
  readonly status?: string
  readonly commit?: string
  readonly commit_message?: string
  readonly created_at?: string
  readonly updated_at?: string
  readonly logs?: string
  readonly deployment_url?: string
  readonly pull_request_id?: number
  readonly [key: string]: unknown
}
