/**
 * Coolify reports container state as a free-form `Application.status` string,
 * typically `<state>:<health>` such as `running:healthy`, `running:unhealthy`,
 * `restarting:unhealthy`, or just `exited`. The OpenAPI schema types it as a
 * plain string with no enum, so this parser is deliberately tolerant: unknown
 * tokens degrade to `unknown` rather than throwing or lying.
 */

export type RuntimeState =
  | "running"
  | "starting"
  | "restarting"
  | "paused"
  | "degraded"
  | "exited"
  | "unknown"

export type RuntimeHealth = "healthy" | "unhealthy" | "none"

export interface RuntimeStatus {
  /** The untouched value from Coolify, for display and debugging. */
  readonly raw: string
  readonly state: RuntimeState
  readonly health: RuntimeHealth
  /** Human-readable summary, e.g. `running (healthy)` or `exited`. */
  readonly label: string
}

const STATE_ALIASES: Readonly<Record<string, RuntimeState>> = {
  running: "running",
  up: "running",
  starting: "starting",
  created: "starting",
  initializing: "starting",
  restarting: "restarting",
  paused: "paused",
  degraded: "degraded",
  exited: "exited",
  stopped: "exited",
  dead: "exited",
  killed: "exited",
  removed: "exited",
}

function toHealth(token: string | undefined): RuntimeHealth {
  if (token === "healthy") return "healthy"
  if (token === "unhealthy") return "unhealthy"
  return "none"
}

export function parseApplicationStatus(raw: string | undefined | null): RuntimeStatus {
  const value = (raw ?? "").trim()
  if (value === "") return { raw: "", state: "unknown", health: "none", label: "unknown" }

  const parts = value.toLowerCase().split(":")
  const first = parts[0] ?? ""

  let state: RuntimeState
  let health: RuntimeHealth

  if (parts.length >= 2) {
    state = STATE_ALIASES[first] ?? "unknown"
    health = toHealth(parts[1])
  } else if (first === "healthy" || first === "unhealthy") {
    // Some responses carry only the health verdict, with no state prefix.
    state = "unknown"
    health = toHealth(first)
  } else {
    state = STATE_ALIASES[first] ?? "unknown"
    health = "none"
  }

  return { raw: value, state, health, label: label(state, health) }
}

function label(state: RuntimeState, health: RuntimeHealth): string {
  if (state === "unknown") return health === "none" ? "unknown" : health
  return health === "none" ? state : `${state} (${health})`
}

/** Coarse severity, so callers can pick a colour without re-deriving state. */
export type RuntimeTone = "ok" | "warn" | "bad" | "unknown"

export function runtimeTone(status: RuntimeStatus): RuntimeTone {
  switch (status.state) {
    case "running":
      return status.health === "unhealthy" ? "warn" : "ok"
    case "starting":
    case "restarting":
    case "paused":
    case "degraded":
      return "warn"
    case "exited":
      return "bad"
    default:
      return status.health === "unhealthy" ? "bad" : "unknown"
  }
}

export type DeploymentStatus = "queued" | "in_progress" | "finished" | "failed" | "cancelled" | "unknown"

/**
 * Coolify's deployment queue uses a free-form `status` string. Map the values
 * it emits, and the obvious spelling variants, onto a small closed set.
 */
export function normalizeDeploymentStatus(raw: string | undefined): DeploymentStatus {
  switch ((raw ?? "").toLowerCase()) {
    case "queued":
    case "pending":
    case "scheduled":
    case "waiting":
      return "queued"
    case "in_progress":
    case "running":
    case "building":
    case "deploying":
    case "starting":
      return "in_progress"
    case "finished":
    case "success":
    case "succeeded":
    case "completed":
      return "finished"
    case "failed":
    case "error":
      return "failed"
    case "cancelled":
    case "canceled":
    case "cancelled-by-user":
      return "cancelled"
    default:
      return "unknown"
  }
}
