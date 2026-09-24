import type { CoolifyClient } from "./client"
import { CoolifyError, UNKNOWN_PROBE, type Capability, type CapabilityProbe, type CapabilityReport, type TeamRef } from "./types"

/**
 * A UUID that cannot exist on a real instance.
 *
 * The `write` and `deploy` probes deliberately target this identifier so that a
 * "granted" verdict can never mutate a real resource: the request always fails
 * resource lookup, which happens only after Coolify's permission middleware.
 */
export const PROBE_UUID = "opencode-probe-00000000-0000-0000-0000-000000000000"

export interface ProbeOptions {
  readonly signal?: AbortSignal
  /**
   * Probe `read:sensitive` by inspecting the first application's environment
   * values for redaction. On by default: logs and env values depend on the
   * ability, and an inconclusive probe reports `unknown` rather than guessing.
   */
  readonly includeSensitive?: boolean
}

interface ProbeSpec {
  readonly capability: Capability
  readonly summary: string
  readonly run: () => Promise<unknown>
}

/**
 * Determine which abilities the configured token has.
 *
 * Coolify has no "who am I" endpoint for abilities, and a `deploy`-only token
 * cannot even list projects. So each ability is probed with a request that
 * isolates it. A `403` is the documented proof that an ability is absent; any
 * other outcome means the permission check passed and the request failed later
 * for an unrelated reason.
 *
 * `read:sensitive` is probed eagerly because logs and environment values depend
 * on it, and a redacted log otherwise looks identical to an application that
 * genuinely produced no output.
 */
export async function probeCapabilities(
  client: CoolifyClient,
  options: ProbeOptions = { includeSensitive: true },
): Promise<CapabilityReport> {
  const team = await readTeam(client, options.signal)

  const read = await probe({
    capability: "read",
    summary: "GET /projects",
    run: () => client.request({ method: "GET", path: "/projects", signal: options.signal }),
  })

  const write = await probe({
    capability: "write",
    summary: `DELETE /applications/${PROBE_UUID}`,
    run: () => client.request({ method: "DELETE", path: `/applications/${PROBE_UUID}`, signal: options.signal }),
  })

  const deploy = await probe({
    capability: "deploy",
    summary: `POST /deploy?uuid=${PROBE_UUID}`,
    run: () =>
      client.request({
        method: "POST",
        path: "/deploy",
        query: { uuid: PROBE_UUID },
        signal: options.signal,
      }),
  })

  const sensitive = options.includeSensitive ? await probeSensitive(client, options.signal) : UNKNOWN_PROBE

  const probes: Record<Capability, CapabilityProbe> = {
    read,
    "read:sensitive": sensitive,
    write,
    deploy,
  }

  const notes = [
    "Coolify exposes no endpoint that reports a token's abilities, so these verdicts are probed.",
    "The write and deploy probes target a UUID that cannot exist, so a granted verdict has no side effect.",
    "A 403 proves an ability is absent; any other response means the permission check passed.",
  ]

  if (sensitive.status === "unknown") {
    notes.push("`read:sensitive` is unknown until a redacted field is first requested.")
  }
  if (read.status === "denied" && deploy.status === "granted") {
    notes.push("This looks like a deploy-only token: it can trigger deployments but cannot discover resources.")
  }

  const likelyRoot = read.status === "granted" && write.status === "granted" && deploy.status === "granted"
  if (likelyRoot) {
    notes.push("Every probed ability passed, which is consistent with a `root` token.")
  }

  return { endpoint: client.endpoint, team, probes, likelyRoot, checkedAt: Date.now(), notes }
}

async function probe(spec: ProbeSpec): Promise<CapabilityProbe> {
  try {
    await spec.run()
    return { status: "granted", detail: `${spec.summary} was accepted` }
  } catch (error) {
    if (!(error instanceof CoolifyError)) throw error

    // An invalid token is not a verdict about abilities; surface it instead.
    if (error.kind === "unauthorized") throw error

    if (error.kind === "forbidden" || error.kind === "missing_sensitive") {
      return {
        status: "denied",
        detail: `${spec.summary} returned 403 (${error.message})`,
      }
    }

    // not_found / validation / server / rate_limited all mean the permission
    // middleware let the request through, so the ability itself is present.
    return {
      status: "granted",
      detail: `${spec.summary} returned ${error.status ?? "an error"} (${error.message}), so the permission check passed`,
    }
  }
}

async function probeSensitive(client: CoolifyClient, signal?: AbortSignal): Promise<CapabilityProbe> {
  const summary = `GET /applications/<first>/envs`
  try {
    const applications = await client.request<readonly { uuid: string }[]>({
      method: "GET",
      path: "/applications",
      signal,
    })
    const uuid = applications?.[0]?.uuid
    if (!uuid) return { status: "unknown", detail: "no application available to probe env values" }

    const envs = await client.request<readonly { key: string; value?: string }[]>({
      method: "GET",
      path: `/applications/${uuid}/envs`,
      signal,
    })

    const values = (envs ?? [])
      .map((env) => env.value)
      .filter((value): value is string => typeof value === "string" && value !== "")

    // An application with no readable values tells us nothing either way, so
    // stay honest rather than guessing from an absence.
    if (values.length === 0) {
      return { status: "unknown", detail: `${summary} had no values to compare` }
    }
    if (values.some((value) => /^\*+$/.test(value))) {
      return { status: "denied", detail: `${summary} returned redacted values` }
    }
    return { status: "granted", detail: `${summary} returned unredacted values` }
  } catch (error) {
    if (error instanceof CoolifyError && error.kind === "missing_sensitive") {
      return { status: "denied", detail: `${summary} returned 403 (${error.message})` }
    }
    if (error instanceof CoolifyError && error.kind === "unauthorized") throw error
    return { status: "unknown", detail: `${summary} could not be interpreted` }
  }
}

async function readTeam(client: CoolifyClient, signal?: AbortSignal): Promise<TeamRef | undefined> {
  try {
    const team = await client.request<{ id?: number | string; name?: string }>({
      method: "GET",
      path: "/team",
      signal,
    })
    if (!team || typeof team !== "object") return undefined
    return {
      ...(team.id === undefined ? {} : { id: String(team.id) }),
      ...(team.name === undefined ? {} : { name: team.name }),
    }
  } catch {
    return undefined
  }
}
