import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { CoolifyClient } from "../src/coolify/client"
import { buildTools, type ToolDeps } from "../src/tools"
import { makeFetch, memoryStore, report } from "./helpers"

const context = {
  signal: new AbortController().signal,
  progress: async () => {},
} as unknown as ToolContext

function deps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  const fake = makeFetch([])
  return {
    store: memoryStore(),
    projectID: "proj",
    directory: "/tmp",
    endpoint: "https://coolify.test",
    getClient: () => new CoolifyClient({ endpoint: "coolify.test", token: "secret", fetch: fake.fetch }),
    getCapabilities: () => report({ read: "granted", write: "granted", deploy: "granted" }),
    getLink: () => undefined,
    setLink: async () => {},
    emitDeployProgress: () => {},
    emitProjectChanged: () => {},
    ...overrides,
  }
}

const names = (tools: ReturnType<typeof buildTools>) => tools.map((tool) => tool.name)

describe("buildTools", () => {
  it("offers the whole surface to a root token", () => {
    const list = names(buildTools(deps()))
    expect(list).toEqual(
      expect.arrayContaining([
        "capabilities",
        "configure_project",
        "resolve",
        "link",
        "unlink",
        "status",
        "list_resources",
        "deployment_status",
        "databases",
        "application",
        "env_value",
        "application_update",
        "create_database",
        "deploy",
        "destroy",
        "plan_application",
        "application",
        "application_update",
        "env_value",
        "database",
        "database_manage",
        "project",
        "project_manage",
        "create_application",
      ]),
    )
  })

  it("declares a permission tier on every tool", () => {
    const tiers = Object.fromEntries(buildTools(deps()).map((tool) => [tool.name, tool.tier]))
    expect(tiers).toEqual({
      capabilities: "read",
      resolve: "read",
      status: "read",
      list_resources: "read",
      deployment_status: "read",
      plan_application: "read",
      application: "read",
      databases: "read",
      database: "read",
      project: "read",
      configure_project: "write",
      link: "write",
      unlink: "write",
      application_update: "write",
      create_application: "write",
      create_database: "write",
      database_manage: "write",
      project_manage: "write",
      deploy: "deploy",
      destroy: "destructive",
      env_value: "secrets",
    })
  })

  it("withholds mutating tools from a read-only token", () => {
    const list = names(buildTools(deps({ getCapabilities: () => report({ read: "granted" }) })))
    expect(list).toContain("status")
    expect(list).toContain("resolve")
    expect(list).toContain("databases")
    expect(list).toContain("application")
    expect(list).toContain("env_value")
    expect(list).toContain("configure_project")
    expect(list).not.toContain("application_update")
    expect(list).not.toContain("create_database")
    expect(list).not.toContain("deploy")
  })

  it("offers only local tools to a deploy-only token", () => {
    const list = names(buildTools(deps({ getCapabilities: () => report({ deploy: "granted" }) })))
    expect(list).toEqual(expect.arrayContaining(["capabilities", "configure_project", "resolve", "link", "unlink", "deploy"]))
    expect(list).not.toContain("status")
    expect(list).not.toContain("databases")
    expect(list).not.toContain("application_update")
    expect(list).not.toContain("create_database")
  })

  it("offers only local tools before a token is connected", () => {
    const list = names(buildTools(deps({ getClient: () => undefined, getCapabilities: () => undefined })))
    expect(list).toEqual(["capabilities", "configure_project", "resolve", "link", "unlink"])
  })
})

describe("application_update settings allow-list", () => {
  it("rejects unknown fields without calling Coolify", async () => {
    const fake = makeFetch([])
    const guarded = deps({
      getClient: () => new CoolifyClient({ endpoint: "coolify.test", token: "secret", fetch: fake.fetch }),
    })
    const tool = buildTools(guarded).find((candidate) => candidate.name === "application_update")
    const result = await tool!.run({ action: "settings", settings: { build_pack: "dockerfile", nonsense: true } }, context)

    expect(result.content).toContain("Unknown setting(s): nonsense")
    // The rejected key must not be advertised as accepted, and nothing may reach Coolify.
    expect(result.content).not.toContain("nonsense, ")
    expect(fake.calls).toHaveLength(0)
  })

  it("rejects an empty settings object", async () => {
    const tool = buildTools(deps()).find((candidate) => candidate.name === "application_update")
    const result = await tool!.run({ action: "settings", settings: {} }, context)
    expect(result.content).toContain("empty")
  })
})

function toolFor(name: string, overrides: Partial<ToolDeps> = {}) {
  const tool = buildTools(deps(overrides)).find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`tool ${name} is not registered`)
  return tool
}

describe("configure_project", () => {
  it("writes a monorepo mapping to coolify.json", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coolify-cfg-"))
    const result = await toolFor("configure_project", { directory }).run(
      {
        projectUUID: "proj1",
        environmentName: "production",
        applications: {
          web: { applicationUUID: "web1", path: "apps/web" },
          api: "api1",
        },
        databases: { postgres: { databaseUUID: "db1", type: "postgresql" } },
      },
      context,
    )

    expect(result.content).toContain("apps/web")
    expect(result.content).toContain("Commit this file")

    const written = JSON.parse(await readFile(join(directory, "coolify.json"), "utf8"))
    expect(written.projectUUID).toBe("proj1")
    expect(written.environmentName).toBe("production")
    expect(written.applications.web).toEqual({ applicationUUID: "web1", path: "apps/web" })
    // The string shorthand is accepted and normalized.
    expect(written.applications.api).toEqual({ applicationUUID: "api1" })
    expect(written.databases.postgres).toEqual({ databaseUUID: "db1", type: "postgresql" })
  })

  it("merges into an existing file instead of replacing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coolify-cfg-"))
    await writeFile(
      join(directory, "coolify.json"),
      JSON.stringify({ projectUUID: "proj1", applications: { web: { applicationUUID: "web1" } } }),
      "utf8",
    )

    await toolFor("configure_project", { directory }).run(
      { applications: { api: { applicationUUID: "api1", path: "apps/api" } } },
      context,
    )

    const written = JSON.parse(await readFile(join(directory, "coolify.json"), "utf8"))
    expect(Object.keys(written.applications).sort()).toEqual(["api", "web"])
    expect(written.projectUUID).toBe("proj1")
  })

  it("announces the change so open UIs re-read the mapping", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coolify-cfg-"))
    const announced: string[] = []
    const tool = buildTools({ ...deps({ directory }), emitProjectChanged: (file) => announced.push(file) }).find(
      (candidate) => candidate.name === "configure_project",
    )
    await tool!.run({ projectUUID: "p1" }, context)

    expect(announced).toHaveLength(1)
    expect(announced[0]).toBe(join(directory, "coolify.json"))
  })

  it("refuses when there is nothing to write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coolify-cfg-"))
    const result = await toolFor("configure_project", { directory }).run({}, context)
    expect(result.content).toContain("Nothing to write")
  })
})

describe("databases", () => {
  it("lists databases with runtime status", async () => {
    const fake = makeFetch([
      {
        method: "GET",
        path: "/databases",
        status: 200,
        body: [
          { uuid: "db1", type: "postgresql", name: "acme-db", status: "running:healthy", project_uuid: "p1", environment_name: "production" },
        ],
      },
    ])
    const result = await toolFor("databases", {
      getClient: () => new CoolifyClient({ endpoint: "coolify.test", token: "t", fetch: fake.fetch }),
    }).run({}, context)

    expect(result.content).toContain("db1")
    expect(result.content).toContain("postgresql")
    expect(result.content).toContain("running (healthy)")
  })

  it("filters by project", async () => {
    const fake = makeFetch([
      {
        method: "GET",
        path: "/databases",
        status: 200,
        body: [
          { uuid: "db1", type: "postgresql", project_uuid: "p1" },
          { uuid: "db2", type: "redis", project_uuid: "p2" },
        ],
      },
    ])
    const result = await toolFor("databases", {
      getClient: () => new CoolifyClient({ endpoint: "coolify.test", token: "t", fetch: fake.fetch }),
    }).run({ projectUUID: "p2" }, context)

    expect(result.content).toContain("db2")
    expect(result.content).not.toContain("db1")
  })
})

describe("create_database", () => {
  it("rejects an unsupported type", async () => {
    const result = await toolFor("create_database").run({ type: "sqlite" }, context)
    expect(result.content).toContain("Unsupported database type")
  })

  it("explains how to supply placement when it cannot be inferred", async () => {
    const fake = makeFetch([])
    const result = await toolFor("create_database", {
      directory: await mkdtemp(join(tmpdir(), "coolify-cfg-")),
      getClient: () => new CoolifyClient({ endpoint: "coolify.test", token: "t", fetch: fake.fetch }),
    }).run({ type: "postgresql" }, context)

    expect(result.content).toContain("Cannot determine where to create the database")
  })

  it("creates the database and resolves the environment UUID", async () => {
    const fake = makeFetch([
      { method: "GET", path: "/projects/proj1/environments", status: 200, body: [{ name: "production", uuid: "env1" }] },
      { method: "POST", path: "/databases/postgresql", status: 201, body: { uuid: "db-uuid" } },
    ])

    const result = await toolFor("create_database", {
      directory: await mkdtemp(join(tmpdir(), "coolify-cfg-")),
      getClient: () => new CoolifyClient({ endpoint: "coolify.test", token: "t", fetch: fake.fetch }),
    }).run(
      {
        type: "postgresql",
        name: "acme-db",
        projectUUID: "proj1",
        serverUUID: "srv1",
        environmentName: "production",
        settings: { postgres_user: "acme" },
      },
      context,
    )

    expect(result.content).toContain("db-uuid")

    const post = fake.calls.find((call) => call.method === "POST")
    const body = JSON.parse(post?.body ?? "{}")
    expect(body).toMatchObject({
      server_uuid: "srv1",
      project_uuid: "proj1",
      environment_name: "production",
      environment_uuid: "env1",
      name: "acme-db",
      postgres_user: "acme",
    })
  })
})
