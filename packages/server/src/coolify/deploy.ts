import type { CoolifyClient } from "./client"
import type { CoolifyDeployment } from "./types"
import { normalizeDeploymentStatus, type DeploymentStatus } from "@skyvence/coolify-oc-shared/coolify/runtime"

export function isTerminal(status: DeploymentStatus): boolean {
  return status === "finished" || status === "failed" || status === "cancelled"
}

export interface DeployTicket {
  readonly resourceUUID: string
  readonly deploymentUUID: string
  readonly message: string
}

export interface TriggerDeployInput {
  /** Resource UUID. Pass exactly one of `uuid` or `tag`. */
  readonly uuid?: string
  readonly tag?: string
  readonly force?: boolean
  readonly pr?: number
}

export async function triggerDeploy(
  client: CoolifyClient,
  input: TriggerDeployInput,
  signal?: AbortSignal,
): Promise<DeployTicket[]> {
  const result = await client.request<{
    deployments?: readonly { message?: string; resource_uuid?: string; deployment_uuid?: string }[]
  }>({
    method: "POST",
    path: "/deploy",
    query: { uuid: input.uuid, tag: input.tag, force: input.force, pr: input.pr },
    requires: "deploy",
    signal,
  })
  return (result?.deployments ?? []).map((entry) => ({
    resourceUUID: entry.resource_uuid ?? input.uuid ?? "",
    deploymentUUID: entry.deployment_uuid ?? "",
    message: entry.message ?? "",
  }))
}

/** Deployments currently in the queue. */
export function listDeployments(client: CoolifyClient, signal?: AbortSignal): Promise<CoolifyDeployment[]> {
  return client.request({ method: "GET", path: "/deployments", requires: "read", signal })
}

export function listApplicationDeployments(
  client: CoolifyClient,
  applicationUUID: string,
  options: { skip?: number; take?: number; signal?: AbortSignal } = {},
): Promise<unknown[]> {
  return client.request({
    method: "GET",
    path: `/deployments/applications/${applicationUUID}`,
    query: { skip: options.skip, take: options.take },
    requires: "read",
    signal: options.signal,
  })
}

export function getDeployment(
  client: CoolifyClient,
  deploymentUUID: string,
  signal?: AbortSignal,
): Promise<CoolifyDeployment> {
  return client.request({
    method: "GET",
    path: `/deployments/${deploymentUUID}`,
    requires: "read",
    signal,
  })
}

export function cancelDeployment(
  client: CoolifyClient,
  deploymentUUID: string,
  signal?: AbortSignal,
): Promise<{ message?: string; status?: string }> {
  return client.request({
    method: "POST",
    path: `/deployments/${deploymentUUID}/cancel`,
    requires: "deploy",
    signal,
  })
}

export interface WaitOptions {
  readonly signal?: AbortSignal
  readonly intervalMs?: number
  readonly timeoutMs?: number
  readonly onProgress?: (update: { status: DeploymentStatus; raw: string; deployment: CoolifyDeployment }) => void | Promise<void>
}

export interface WaitResult {
  readonly status: DeploymentStatus
  readonly timedOut: boolean
  readonly deployment: CoolifyDeployment | undefined
  readonly polls: number
}

/** Poll a deployment until it reaches a terminal status, times out, or aborts. */
export async function waitForDeployment(
  client: CoolifyClient,
  deploymentUUID: string,
  options: WaitOptions = {},
): Promise<WaitResult> {
  const intervalMs = options.intervalMs ?? 3_000
  const timeoutMs = options.timeoutMs ?? 900_000
  const startedAt = Date.now()
  let polls = 0
  let latest: CoolifyDeployment | undefined

  while (true) {
    options.signal?.throwIfAborted()
    latest = await getDeployment(client, deploymentUUID, options.signal)
    polls += 1
    const status = normalizeDeploymentStatus(latest?.status)
    await options.onProgress?.({ status, raw: latest?.status ?? "", deployment: latest })

    if (isTerminal(status)) return { status, timedOut: false, deployment: latest, polls }
    if (Date.now() - startedAt >= timeoutMs) return { status, timedOut: true, deployment: latest, polls }

    await sleep(intervalMs, options.signal)
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error("aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
