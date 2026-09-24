import { describe, expect, it } from "vitest"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { CoolifyClient } from "../packages/server/src/coolify/client"
import { buildTools, type ToolDeps } from "../packages/server/src/tools"
import { parseDotEnv } from "../packages/server/src/tools/application"
import { makeFetch, memoryStore, report, type FakeRoute } from "./helpers"

const context = { signal: new AbortController().signal, progress: async () => {} } as unknown as ToolContext

const APP_UUID = "app_1"

function deps(routes: readonly FakeRoute[]): ToolDeps {
  const fake = makeFetch(routes)
  return {
    store: memoryStore(),
    projectID: "proj",
    directory: "/tmp",
    endpoint: "https://coolify.test",
    getClient: () => new CoolifyClient({ endpoint: "coolify.test", token: "t", fetch: fake.fetch }),
    // A pinned link keeps resolution offline.
    getCapabilities: () => report({ read: "granted", write: "granted", deploy: "granted" }),
    getLink: () => ({ applicationUUID: APP_UUID, linkedAt: 1, source: "pin" }),
    setLink: async () => {},
    emitDeployProgress: () => {},
    emitProjectChanged: () => {},
  }
}

function toolFor(name: string, routes: readonly FakeRoute[]) {
  const tool = buildTools(deps(routes)).find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`tool ${name} is not registered`)
  return tool
}

describe("parseDotEnv", () => {
  it("parses plain, exported, and quoted entries", () => {
    const entries = parseDotEnv(
      [
        "# comment",
        "",
        "DATABASE_URL=postgres://localhost/db",
        'export API_KEY="secret value"',
        "QUOTED='single'",
        "EMPTY=",
        "not a var line",
        "1INVALID=x",
      ].join("\n"),
    )
    expect(entries).toEqual([
      { key: "DATABASE_URL", value: "postgres://localhost/db" },
      { key: "API_KEY", value: "secret value" },
      { key: "QUOTED", value: "single" },
      { key: "EMPTY", value: "" },
    ])
  })

  it("keeps values containing equals signs", () => {
    expect(parseDotEnv("TOKEN=a=b=c")).toEqual([{ key: "TOKEN", value: "a=b=c" }])
  })
})

describe("application (read)", () => {
  const appRoute: FakeRoute = {
    method: "GET",
    path: `/applications/${APP_UUID}`,
    status: 200,
    body: {
      name: "acme-api",
      fqdn: "https://api.example.com",
      status: "running:healthy",
      build_pack: "dockerfile",
      base_directory: "/apps/api",
      git_branch: "main",
      // A field outside the allow-list must not leak into the settings list.
      internal_notes: "should not appear",
    },
  }

  it("lists only allow-listed settings and the runtime state", async () => {
    const result = await toolFor("application", [appRoute]).run({ action: "settings" }, context)

    expect(result.content).toContain("acme-api")
    expect(result.content).toContain("running (healthy)")
    expect(result.content).toContain("- build_pack: dockerfile")
    expect(result.content).toContain("- base_directory: /apps/api")
    expect(result.content).not.toContain("internal_notes")
  })

  it("lists environment variable names and flags but never values", async () => {
    const result = await toolFor("application", [
      {
        method: "GET",
        path: `/applications/${APP_UUID}/envs`,
        status: 200,
        body: [
          { key: "DATABASE_URL", value: "postgres://user:pw@host/db", is_literal: true },
          { key: "FEATURE_FLAG", value: "on", is_preview: true },
        ],
      },
    ]).run({ action: "envs" }, context)

    expect(result.content).toContain("DATABASE_URL")
    expect(result.content).toContain("literal")
    expect(result.content).toContain("preview")
    expect(result.content).not.toContain("postgres://user:pw@host/db")
    expect(result.content).not.toContain("pw@host")
  })

  it("explains an empty log as a permissions problem, not an absence of logs", async () => {
    const result = await toolFor("application", [
      { method: "GET", path: `/applications/${APP_UUID}/logs`, status: 200, body: { logs: "" } },
    ]).run({ action: "logs" }, context)

    expect(result.content).toContain("read:sensitive")
  })

  it("warns the model when logs are returned that they may contain secrets", async () => {
    const result = await toolFor("application", [
      { method: "GET", path: `/applications/${APP_UUID}/logs`, status: 200, body: { logs: "line one\nline two" } },
    ]).run({ action: "logs" }, context)

    expect(result.content).toContain("line one")
    expect(result.content).toContain("may contain secrets")
  })

  it("rejects an unknown action without calling Coolify", async () => {
    const fake = makeFetch([])
    const depsWithFake: ToolDeps = { ...deps([]), getClient: () => new CoolifyClient({ endpoint: "coolify.test", token: "t", fetch: fake.fetch }) }
    const tool = buildTools(depsWithFake).find((candidate) => candidate.name === "application")!
    const result = await tool.run({ action: "nope" }, context)

    expect(result.content).toContain("Unknown action")
    expect(fake.calls).toHaveLength(0)
  })
})

describe("env_value (secrets)", () => {
  const envRoute = (value: unknown): FakeRoute => ({
    method: "GET",
    path: `/applications/${APP_UUID}/envs`,
    status: 200,
    body: [{ key: "API_KEY", value }],
  })

  it("returns the value when Coolify supplies one", async () => {
    const result = await toolFor("env_value", [envRoute("s3cret")]).run({ key: "API_KEY" }, context)
    expect(result.content).toBe("API_KEY=s3cret")
  })

  it("reports redaction rather than pretending the value is empty", async () => {
    const result = await toolFor("env_value", [envRoute("********")]).run({ key: "API_KEY" }, context)
    expect(result.content).toContain("redacted")
    expect(result.metadata?.redacted).toBe(true)
  })

  it("points at read:sensitive when no value comes back", async () => {
    const result = await toolFor("env_value", [envRoute(undefined)]).run({ key: "API_KEY" }, context)
    expect(result.content).toContain("read:sensitive")
  })

  it("says so when the key does not exist", async () => {
    const result = await toolFor("env_value", [envRoute("x")]).run({ key: "MISSING" }, context)
    expect(result.content).toContain("No environment variable named MISSING")
  })
})

describe("application_update (write)", () => {
  it("rejects an unknown setting before touching the network", async () => {
    const fake = makeFetch([])
    const depsWithFake: ToolDeps = { ...deps([]), getClient: () => new CoolifyClient({ endpoint: "coolify.test", token: "t", fetch: fake.fetch }) }
    const tool = buildTools(depsWithFake).find((candidate) => candidate.name === "application_update")!
    const result = await tool.run({ action: "settings", settings: { nonsense: 1 } }, context)

    expect(result.content).toContain("Unknown setting")
    expect(fake.calls).toHaveLength(0)
  })

  it("syncs a .env file and reports counts without values", async () => {
    const fake = makeFetch([
      { method: "GET", path: `/applications/${APP_UUID}/envs`, status: 200, body: [{ key: "EXISTING", value: "old" }] },
      { method: "POST", path: `/applications/${APP_UUID}/envs`, status: 201, body: { uuid: "env_new" } },
      { method: "PATCH", path: `/applications/${APP_UUID}/envs`, status: 201, body: { uuid: "env_old" } },
    ])
    const depsWithFake: ToolDeps = {
      ...deps([]),
      directory: await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/coolify-sync-")),
      getClient: () => new CoolifyClient({ endpoint: "coolify.test", token: "t", fetch: fake.fetch }),
    }
    const { writeFile } = await import("node:fs/promises")
    const { join } = await import("node:path")
    await writeFile(join(depsWithFake.directory, ".env"), "EXISTING=new\nADDED=fresh\n", "utf8")

    const tool = buildTools(depsWithFake).find((candidate) => candidate.name === "application_update")!
    const result = await tool.run({ action: "env_sync", file: ".env" }, context)

    expect(result.content).toContain("1 created, 1 updated")
    expect(result.content).not.toContain("fresh")
    expect(result.content).not.toContain("new")
  })
})
