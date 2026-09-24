import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CapabilityReport } from "../packages/server/src/coolify/types"

export interface FakeRoute {
  readonly method: string
  readonly path: string | RegExp
  readonly status: number
  readonly body?: unknown
}

export interface FakeFetch {
  readonly fetch: typeof globalThis.fetch
  readonly calls: { method: string; url: string; body?: string }[]
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function matches(route: FakeRoute, method: string, pathname: string): boolean {
  if (route.method.toUpperCase() !== method) return false
  return typeof route.path === "string" ? pathname.endsWith(route.path) : route.path.test(pathname)
}

/**
 * A fetch stub that answers from an ordered route table and records every call,
 * so tests can assert both behaviour and absence of side effects.
 */
export function makeFetch(routes: readonly FakeRoute[]): FakeFetch {
  const calls: { method: string; url: string; body?: string }[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? "GET").toUpperCase()
    calls.push({
      method,
      url: url.toString(),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    })
    const route = routes.find((candidate) => matches(candidate, method, url.pathname))
    if (!route) return jsonResponse(404, { message: `no route for ${method} ${url.pathname}` })
    return jsonResponse(route.status, route.body)
  }) as typeof globalThis.fetch
  return { fetch: fetchImpl, calls }
}

export function report(
  probes: Partial<Record<"read" | "read:sensitive" | "write" | "deploy", "granted" | "denied" | "unknown">>,
): CapabilityReport {
  const probe = (status: "granted" | "denied" | "unknown" = "unknown") => ({ status, detail: `stub ${status}` })
  return {
    endpoint: "https://coolify.test/api/v1",
    probes: {
      read: probe(probes.read),
      "read:sensitive": probe(probes["read:sensitive"]),
      write: probe(probes.write),
      deploy: probe(probes.deploy),
    },
    likelyRoot: probes.read === "granted" && probes.write === "granted" && probes.deploy === "granted",
    checkedAt: 0,
    notes: [],
  }
}

/** Create a temp directory containing a `.git/config` with an origin remote. */
export async function projectWithGitRemote(remote: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coolify-test-"))
  await mkdir(join(directory, ".git"), { recursive: true })
  await writeFile(
    join(directory, ".git", "config"),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${remote}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
    "utf8",
  )
  return directory
}

/** Create a temp directory with a `.coolify.json` in it. */
export async function projectWithConfig(applicationUUID: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coolify-test-"))
  await writeFile(join(directory, ".coolify.json"), JSON.stringify({ applicationUUID }), "utf8")
  return directory
}

export function memoryStore(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial))
  return {
    data,
    async get(key: string) {
      return data.get(key)
    },
    async set(key: string, value: unknown) {
      data.set(key, value)
    },
    async remove(key: string) {
      data.delete(key)
    },
  }
}
