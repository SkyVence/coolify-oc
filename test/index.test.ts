import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { normalizeEndpoint } from "../src/coolify/client"
import type { CapabilityReport } from "../src/coolify/types"
import { capabilityKey } from "../src/store"
import { makeFetch, memoryStore, report, type FakeRoute } from "./helpers"

const ENDPOINT = "https://coolify.test"
/** RPC handlers receive this as their second argument. */
const RPC_CONTEXT = { signal: new AbortController().signal }
const TOKEN = "1|test-token"

/** A route table that answers the capability probes as a root token would. */
const ROOT_PROBES: FakeRoute[] = [
  { method: "GET", path: "/team", status: 200, body: { id: 0, name: "Root Team" } },
  { method: "GET", path: "/projects", status: 200, body: [] },
  { method: "DELETE", path: /\/applications\/opencode-probe-/, status: 404, body: { message: "Application not found." } },
  { method: "POST", path: "/deploy", status: 400, body: { message: "No resources found." } },
  { method: "GET", path: "/applications", status: 200, body: [{ uuid: "app_1" }] },
  { method: "GET", path: "/applications/app_1/envs", status: 200, body: [{ key: "K", value: "v" }] },
]

/** A token that can read but not write or deploy. */
const READ_ONLY_PROBES: FakeRoute[] = [
  { method: "GET", path: "/team", status: 200, body: { id: 0, name: "Root Team" } },
  { method: "GET", path: "/projects", status: 200, body: [] },
  { method: "DELETE", path: /\/applications\/opencode-probe-/, status: 403, body: { message: "No" } },
  { method: "POST", path: "/deploy", status: 403, body: { message: "No" } },
]

interface HarnessOptions {
  readonly routes?: readonly FakeRoute[]
  readonly directory?: string
  readonly options?: Record<string, unknown>
  readonly token?: string | undefined
  /** Seed plugin storage before setup runs, e.g. a cached capability report. */
  readonly seed?: (store: ReturnType<typeof memoryStore>) => Promise<void>
}

async function harness(input: HarnessOptions = {}) {
  const fake = makeFetch(input.routes ?? ROOT_PROBES)
  vi.stubGlobal("fetch", fake.fetch)

  const directory = input.directory ?? (await mkdtemp(join(tmpdir(), "coolify-idx-")))
  const store = memoryStore()
  await input.seed?.(store)

  const handlers: any = {}
  const emitted: { name: string; data: any }[] = []
  const tools: any[] = []
  const toolTransforms: ((editor: any) => void)[] = []
  const namespaces: any[] = []
  const toolEditor = {
    namespace: (ns: any) => void namespaces.push(ns),
    add: (tool: any) => void tools.push(tool),
    update: () => {},
    remove: () => {},
    list: () => [],
    get: () => undefined,
  }

  const context: any = {
    app: { version: "test", channel: "test" },
    options: { endpoint: ENDPOINT, ...input.options },
    location: { directory, project: { id: "proj_test", directory, canonical: directory } },
    storage: store,
    integration: {
      transform: async (callback: any) => {
        callback({ update: () => {}, remove: () => {}, list: () => [], get: () => undefined, method: { update: () => {}, list: () => [], remove: () => {} } })
        return { dispose: async () => {} }
      },
      connection: {
        active: async () => (input.token === undefined ? undefined : { type: "credential", id: "cred_1", label: "Coolify" }),
        resolve: async () => (input.token === undefined ? undefined : { type: "key", key: input.token }),
      },
    },
    tool: {
      transform: async (callback: any) => {
        toolTransforms.push(callback)
        return { dispose: async () => {} }
      },
      reload: async () => {
        tools.length = 0
        namespaces.length = 0
        for (const callback of toolTransforms) callback(toolEditor)
      },
    },
    rpc: {
      register: async (_definition: any, registered: any) => {
        Object.assign(handlers, registered)
        return {
          dispose: async () => {},
          events: { emit: async (name: string, data: any) => void emitted.push({ name, data }) },
        }
      },
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) return resolve()
            options?.signal?.addEventListener("abort", () => resolve(), { once: true })
          })
        },
      }),
    },
  }

  const plugin = (await import("../src/index")).default
  const cleanup = await plugin.setup(context)

  return {
    handlers,
    emitted,
    tools,
    namespaces,
    calls: fake.calls,
    store,
    directory,
    context,
    cleanup: async () => {
      await cleanup?.()
    },
    /** What the model would actually see, after a reload. */
    toolNames: () => tools.map((tool) => tool.name),
    callsTo: (method: string, fragment: string) =>
      fake.calls.filter((call) => call.method === method && call.url.includes(fragment)),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("capability probing and gating", () => {
  it("builds the client even when a fresh report is cached, and skips the probe", async () => {
    const seeded: CapabilityReport = { ...report({ read: "granted", write: "granted", deploy: "granted" }), checkedAt: Date.now() }
    const h = await harness({
      token: TOKEN,
      seed: async (store) => {
        await store.set(capabilityKey(normalizeEndpoint(ENDPOINT)), seeded)
      },
    })

    // A fresh report must not suppress building the client: doing so would hide
    // every read-gated tool behind an "unconfigured" instance.
    expect(h.toolNames()).toContain("status")
    expect(h.toolNames()).toContain("application")
    expect(h.callsTo("GET", "/projects")).toHaveLength(0)
    await h.cleanup()
  })

  it("probes once for concurrent refreshes", async () => {
    const h = await harness({ token: TOKEN })
    const before = h.callsTo("GET", "/projects").length

    await Promise.all([h.handlers.refreshCapabilities({}), h.handlers.refreshCapabilities({})])

    expect(h.callsTo("GET", "/projects").length - before).toBe(1)
    await h.cleanup()
  })

  it("hides every mutating tool from a read-only token", async () => {
    const h = await harness({ token: TOKEN, routes: READ_ONLY_PROBES })
    const names = h.toolNames()

    expect(names).toContain("status")
    expect(names).toContain("application")
    expect(names).not.toContain("application_update")
    expect(names).not.toContain("create_application")
    expect(names).not.toContain("deploy")
    expect(names).not.toContain("destroy")

    const capabilities = await h.handlers.capabilities({})
    expect(capabilities.probes.read.status).toBe("granted")
    expect(capabilities.probes.write.status).toBe("denied")
    await h.cleanup()
  })

  it("learns from a real 403 and rebuilds the tools", async () => {
    const h = await harness({
      token: TOKEN,
      routes: [...ROOT_PROBES, { method: "POST", path: "/applications/app_1/restart", status: 403, body: { message: "No" } }],
    })
    expect((await h.handlers.capabilities({})).probes.deploy.status).toBe("granted")
    expect(h.toolNames()).toContain("deploy")

    // A restart is a deploy-tier call. The refusal must surface as an error and
    // downgrade the report: reactive learning happens on the way out.
    await expect(h.handlers.deploy({ action: "restart", applicationUUID: "app_1" }, RPC_CONTEXT)).rejects.toThrow()

    expect((await h.handlers.capabilities({})).probes.deploy.status).toBe("denied")
    expect(h.toolNames()).not.toContain("deploy")
    expect(h.emitted.some((event) => event.name === "capabilities.changed")).toBe(true)
    await h.cleanup()
  })
})

describe("applications payload", () => {
  it("refuses to answer without a directory", async () => {
    const h = await harness({ token: TOKEN })
    const payload = await h.handlers.applications({ scope: "mapped" })

    // Guessing the server's own location is how every TUI showed one project.
    expect(payload.apps).toEqual([])
    expect(payload.message).toContain("No project directory")
    await h.cleanup()
  })

  it("reads the project named by the directory, not the instance's own", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coolify-idx-"))
    await writeFile(
      join(directory, "coolify.json"),
      JSON.stringify({ projectUUID: "proj_1", applications: { web: { applicationUUID: "app_1", path: "apps/web" } } }),
      "utf8",
    )
    const h = await harness({
      token: TOKEN,
      directory: "/somewhere/else",
      routes: [
        ...ROOT_PROBES,
        { method: "GET", path: "/applications/app_1", status: 200, body: { uuid: "app_1", name: "web", status: "running:healthy" } },
      ],
    })

    const payload = await h.handlers.applications({ scope: "mapped", directory })

    expect(payload.configFile).toBe(join(directory, "coolify.json"))
    expect(payload.apps).toHaveLength(1)
    expect(payload.apps[0].name).toBe("web")
    expect(payload.apps[0].runtime.state).toBe("running")
    await h.cleanup()
  })

  it("fetches the deployment queue at most once for the whole payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coolify-idx-"))
    await writeFile(
      join(directory, "coolify.json"),
      JSON.stringify({
        applications: {
          a: { applicationUUID: "app_1" },
          b: { applicationUUID: "app_2" },
          c: { applicationUUID: "app_3" },
        },
      }),
      "utf8",
    )
    const h = await harness({
      token: TOKEN,
      routes: [
        ...ROOT_PROBES,
        // per-app history returns nothing, forcing the shared-queue fallback
        { method: "GET", path: "/deployments/applications/", status: 200, body: [] },
        { method: "GET", path: "/deployments", status: 200, body: [] },
        { method: "GET", path: "/applications/app_2", status: 200, body: { uuid: "app_2", name: "b" } },
        { method: "GET", path: "/applications/app_3", status: 200, body: { uuid: "app_3", name: "c" } },
      ],
    })

    await h.handlers.applications({ scope: "mapped", directory })

    // Three applications, one queue fetch — not one per application. Matching
    // the exact endpoint matters: "/deployments/applications/<uuid>" contains
    // the same substring and would inflate the count.
    const queueFetches = h.calls.filter(
      (call) => call.method === "GET" && call.url.endsWith("/api/v1/deployments"),
    )
    expect(queueFetches).toHaveLength(1)
    await h.cleanup()
  })

  it("passes the refresh cadence option through, ignoring invalid values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coolify-idx-"))
    await writeFile(join(directory, "coolify.json"), JSON.stringify({ applications: {} }), "utf8")

    const valid = await harness({ token: TOKEN, options: { refreshSeconds: 42 } })
    expect((await valid.handlers.applications({ scope: "mapped", directory })).refreshSeconds).toBe(42)
    await valid.cleanup()

    const invalid = await harness({ token: TOKEN, options: { refreshSeconds: 3 } })
    expect((await invalid.handlers.applications({ scope: "mapped", directory })).refreshSeconds).toBe(25)
    await invalid.cleanup()
  })
})

describe("recursiveProjects toggle", () => {
  async function twoConfigRepo(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "coolify-idx-"))
    await mkdir(join(directory, ".git"), { recursive: true })
    await mkdir(join(directory, "apps", "web"), { recursive: true })
    await writeFile(
      join(directory, "coolify.json"),
      JSON.stringify({ applications: { worker: { applicationUUID: "app_w" } } }),
      "utf8",
    )
    await writeFile(
      join(directory, "apps", "web", "coolify.json"),
      JSON.stringify({ applications: { web: { applicationUUID: "app_1" } } }),
      "utf8",
    )
    return directory
  }

  const routes: FakeRoute[] = [
    ...ROOT_PROBES,
    { method: "GET", path: "/applications/app_w", status: 200, body: { uuid: "app_w", name: "worker" } },
  ]

  it("looks at one config only by default", async () => {
    const directory = await twoConfigRepo()
    const h = await harness({ token: TOKEN, routes })

    const payload = await h.handlers.applications({ scope: "mapped", directory })

    expect(payload.recursiveProjects).toBe(false)
    // No groups, so the sidebar renders the single nearest config from `apps`.
    expect(payload.projects ?? []).toHaveLength(0)
    expect(payload.apps.map((app: any) => app.name)).toEqual(["worker"])
    await h.cleanup()
  })

  it("shows one group per config when switched on", async () => {
    const directory = await twoConfigRepo()
    const h = await harness({ token: TOKEN, routes, options: { recursiveProjects: true } })

    const payload = await h.handlers.applications({ scope: "mapped", directory })

    expect(payload.recursiveProjects).toBe(true)
    expect(payload.projects).toHaveLength(2)
    expect(payload.projects.map((group: any) => group.relativeFile).sort()).toEqual([
      "apps/web/coolify.json",
      "coolify.json",
    ])
    await h.cleanup()
  })

  it("stays off for anything that is not the boolean true", async () => {
    const directory = await twoConfigRepo()
    const h = await harness({ token: TOKEN, routes, options: { recursiveProjects: "true" } })

    expect((await h.handlers.applications({ scope: "mapped", directory })).recursiveProjects).toBe(false)
    await h.cleanup()
  })
})

describe("configureProject", () => {
  it("writes inside a repository and announces it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coolify-idx-"))
    await mkdir(join(directory, ".git"), { recursive: true })
    const h = await harness({ token: TOKEN, directory })

    const result = await h.handlers.configureProject({
      directory,
      projectUUID: "proj_1",
      applications: { web: { applicationUUID: "app_1", path: "apps/web" } },
    })

    expect(result.ok).toBe(true)
    const written = JSON.parse(await readFile(join(directory, "coolify.json"), "utf8"))
    expect(written.projectUUID).toBe("proj_1")
    expect(written.applications.web.applicationUUID).toBe("app_1")
    expect(h.emitted.some((event) => event.name === "project.changed")).toBe(true)
    await h.cleanup()
  })

  it("refuses outside a repository rather than scattering a config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coolify-idx-"))
    const h = await harness({ token: TOKEN, directory })

    const result = await h.handlers.configureProject({ directory, projectUUID: "proj_1" })

    expect(result.ok).toBe(false)
    expect(result.message).toContain("not inside a git repository")
    await expect(readFile(join(directory, "coolify.json"), "utf8")).rejects.toThrow()
    await h.cleanup()
  })
})

describe("resolve", () => {
  it("refuses without a directory instead of resolving the instance's own", async () => {
    const h = await harness({ token: TOKEN })
    const result = await h.handlers.resolve({})

    expect(result.source).toBe("none")
    expect(result.notes.join(" ")).toContain("No project directory")
    await h.cleanup()
  })
})

describe("setEndpoint", () => {
  it("rejects an unusable URL without touching the network", async () => {
    const h = await harness({ token: TOKEN })
    const before = h.calls.length

    const result = await h.handlers.setEndpoint({ endpoint: "not a url" })

    expect(result.ok).toBe(false)
    expect(h.calls.length).toBe(before)
    await h.cleanup()
  })
})
