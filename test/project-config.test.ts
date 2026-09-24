import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  databasesFor,
  findAllProjectConfigs,
  findProjectConfig,
  findRepositoryRoot,
  isWithin,
  normalizePath,
  parseProjectConfig,
  validateProjectJson,
  selectApplication,
  updateProjectConfig,
} from "../packages/server/src/project-config"

async function tempRepo(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coolify-repo-"))
  await mkdir(join(directory, ".git"), { recursive: true })
  return directory
}

const MONOREPO = {
  projectUUID: "proj_1",
  environmentName: "production",
  serverUUID: "srv_1",
  applications: {
    web: { applicationUUID: "web_uuid", path: "apps/web" },
    api: { applicationUUID: "api_uuid", path: "apps/api" },
    docs: { applicationUUID: "docs_uuid", path: "docs" },
  },
  databases: {
    postgres: { databaseUUID: "pg_uuid", type: "postgresql", path: "apps/api" },
    globalRedis: { databaseUUID: "redis_uuid", type: "redis" },
  },
}

describe("parseProjectConfig", () => {
  it("accepts object, string shorthand, and snake_case aliases", () => {
    const config = parseProjectConfig(
      "/repo/coolify.json",
      JSON.stringify({
        project_uuid: "p1",
        applications: { web: "w1", api: { application_uuid: "a1", path: "apps/api" } },
        databases: { pg: { uuid: "d1" } },
      }),
    )

    expect(config.projectUUID).toBe("p1")
    expect(config.applications.web?.applicationUUID).toBe("w1")
    expect(config.applications.api?.applicationUUID).toBe("a1")
    expect(config.databases.pg?.databaseUUID).toBe("d1")
  })

  it("rejects a non-object document", () => {
    expect(() => parseProjectConfig("/repo/coolify.json", "[]")).toThrow()
  })
})

describe("selectApplication", () => {
  const config = parseProjectConfig("/repo/coolify.json", JSON.stringify(MONOREPO))
  const select = (from: string) => selectApplication(config, from)

  it("picks the application that owns the directory", () => {
    expect(select("/repo/apps/web")?.applicationUUID).toBe("web_uuid")
    expect(select("/repo/apps/api")?.applicationUUID).toBe("api_uuid")
  })

  it("matches a nested directory inside an application's path", () => {
    expect(select("/repo/apps/web/admin")?.applicationUUID).toBe("web_uuid")
    expect(select("/repo/apps/web/admin")?.key).toBe("web")
  })

  it("prefers the longest matching path", () => {
    const nested = parseProjectConfig(
      "/repo/coolify.json",
      JSON.stringify({
        applications: { outer: { applicationUUID: "outer", path: "apps" }, inner: { applicationUUID: "inner", path: "apps/web" } },
      }),
    )
    expect(selectApplication(nested, "/repo/apps/web")?.applicationUUID).toBe("inner")
    expect(selectApplication(nested, "/repo/apps/other")?.applicationUUID).toBe("outer")
  })

  it("stays unresolved in a monorepo when no path matches, so the caller must ask", () => {
    expect(select("/repo/tools")).toBeUndefined()
    expect(select("/repo")?.applicationUUID).toBeUndefined()
  })

  it("falls back to the single-app shorthand", () => {
    const single = parseProjectConfig("/repo/coolify.json", JSON.stringify({ applicationUUID: "only" }))
    expect(selectApplication(single, "/repo")?.applicationUUID).toBe("only")
  })

  it("falls back to a lone applications entry", () => {
    const lone = parseProjectConfig(
      "/repo/coolify.json",
      JSON.stringify({ applications: { web: { applicationUUID: "w1" } } }),
    )
    expect(selectApplication(lone, "/repo")?.applicationUUID).toBe("w1")
  })
})

describe("databasesFor", () => {
  const config = parseProjectConfig("/repo/coolify.json", JSON.stringify(MONOREPO))

  it("includes scoped and unscoped databases", () => {
    expect(Object.keys(databasesFor(config, "/repo/apps/api")).sort()).toEqual(["globalRedis", "postgres"])
  })

  it("excludes databases scoped to another package", () => {
    expect(Object.keys(databasesFor(config, "/repo/apps/web"))).toEqual(["globalRedis"])
  })
})

describe("findProjectConfig", () => {
  it("walks up to the repository root and prefers the nearest file", async () => {
    const directory = await tempRepo()
    await writeFile(join(directory, "coolify.json"), JSON.stringify({ projectUUID: "root" }), "utf8")
    await mkdir(join(directory, "apps/web"), { recursive: true })
    await writeFile(join(directory, "apps", "coolify.json"), JSON.stringify({ projectUUID: "nested" }), "utf8")

    expect((await findProjectConfig(join(directory, "apps/web")))?.projectUUID).toBe("nested")
    expect((await findProjectConfig(join(directory, "apps")))?.projectUUID).toBe("nested")
    expect((await findProjectConfig(directory))?.projectUUID).toBe("root")
  })

  it("ignores a config above the repository root", async () => {
    const outer = await mkdtemp(join(tmpdir(), "coolify-outer-"))
    await writeFile(join(outer, "coolify.json"), JSON.stringify({ projectUUID: "outside" }), "utf8")
    const repo = join(outer, "repo")
    await mkdir(join(repo, ".git"), { recursive: true })

    expect(await findProjectConfig(repo)).toBeUndefined()
  })

  it("returns undefined when there is no config", async () => {
    expect(await findProjectConfig(await tempRepo())).toBeUndefined()
  })
})

describe("findRepositoryRoot", () => {
  it("finds the directory holding the VCS marker", async () => {
    const directory = await tempRepo()
    await mkdir(join(directory, "apps/web"), { recursive: true })

    expect(await findRepositoryRoot(join(directory, "apps/web"))).toBe(directory)
    expect(await findRepositoryRoot(directory)).toBe(directory)
  })

  it("falls back to the starting directory when there is no marker", async () => {
    const orphan = await mkdtemp(join(tmpdir(), "coolify-orphan-"))
    expect(await findRepositoryRoot(orphan)).toBe(orphan)
  })
})

describe("findAllProjectConfigs", () => {
  it("finds every nested config, not just the nearest one", async () => {
    const directory = await tempRepo()
    await writeFile(join(directory, "coolify.json"), JSON.stringify({ projectUUID: "root" }), "utf8")

    await mkdir(join(directory, "apps/web"), { recursive: true })
    await writeFile(join(directory, "apps/web/coolify.json"), JSON.stringify({ projectUUID: "web" }), "utf8")

    await mkdir(join(directory, "apps/api"), { recursive: true })
    await writeFile(join(directory, "apps/api/.coolify.json"), JSON.stringify({ projectUUID: "api" }), "utf8")

    const configs = await findAllProjectConfigs(directory)
    expect(configs).toHaveLength(3)
    expect(configs.map((config) => config.projectUUID).sort()).toEqual(["api", "root", "web"])
  })

  it("sorts the results by path", async () => {
    const directory = await tempRepo()
    await writeFile(join(directory, "coolify.json"), JSON.stringify({ projectUUID: "root" }), "utf8")
    await mkdir(join(directory, "apps/web"), { recursive: true })
    await writeFile(join(directory, "apps/web/coolify.json"), JSON.stringify({ projectUUID: "web" }), "utf8")
    await mkdir(join(directory, "services"), { recursive: true })
    await writeFile(join(directory, "services/coolify.json"), JSON.stringify({ projectUUID: "svc" }), "utf8")

    const files = (await findAllProjectConfigs(directory)).map((config) => config.file)
    expect(files).toEqual([...files].sort())
  })

  it("respects the depth bound", async () => {
    const directory = await tempRepo()
    await mkdir(join(directory, "a/b/c/d"), { recursive: true })
    await writeFile(join(directory, "a/b/c/d/coolify.json"), JSON.stringify({ projectUUID: "depth4" }), "utf8")
    await mkdir(join(directory, "a/b/c/d/e"), { recursive: true })
    await writeFile(join(directory, "a/b/c/d/e/coolify.json"), JSON.stringify({ projectUUID: "depth5" }), "utf8")

    const atDefault = await findAllProjectConfigs(directory)
    expect(atDefault.map((config) => config.projectUUID)).toEqual(["depth4"])

    const deeper = await findAllProjectConfigs(directory, { maxDepth: 5 })
    expect(deeper.map((config) => config.projectUUID).sort()).toEqual(["depth4", "depth5"])
  })

  it("skips noisy directories", async () => {
    const directory = await tempRepo()
    await writeFile(join(directory, "coolify.json"), JSON.stringify({ projectUUID: "root" }), "utf8")
    for (const ignored of ["node_modules", "dist", "build", ".next", "coverage", ".turbo", "vendor"]) {
      await mkdir(join(directory, ignored), { recursive: true })
      await writeFile(join(directory, ignored, "coolify.json"), JSON.stringify({ projectUUID: ignored }), "utf8")
    }
    // `.git` is created by `tempRepo`; a stray config inside it is noise too.
    await writeFile(join(directory, ".git", "coolify.json"), JSON.stringify({ projectUUID: ".git" }), "utf8")

    const configs = await findAllProjectConfigs(directory)
    expect(configs.map((config) => config.projectUUID)).toEqual(["root"])
  })

  it("skips malformed files instead of throwing", async () => {
    const directory = await tempRepo()
    await writeFile(join(directory, "coolify.json"), "{ not json", "utf8")
    await mkdir(join(directory, "web"), { recursive: true })
    await writeFile(join(directory, "web/coolify.json"), JSON.stringify({ projectUUID: "web" }), "utf8")
    await mkdir(join(directory, "api"), { recursive: true })
    await writeFile(join(directory, "api/coolify.json"), "[]", "utf8")

    const configs = await findAllProjectConfigs(directory)
    expect(configs.map((config) => config.projectUUID)).toEqual(["web"])
  })

  it("never follows a symlinked directory", async () => {
    const directory = await tempRepo()
    const external = await mkdtemp(join(tmpdir(), "coolify-external-"))
    await writeFile(join(external, "coolify.json"), JSON.stringify({ projectUUID: "external" }), "utf8")
    await symlink(external, join(directory, "linked"), "dir")

    expect(await findAllProjectConfigs(directory)).toEqual([])
  })
})

describe("updateProjectConfig", () => {
  it("creates the file and merges entries by key", async () => {
    const directory = await tempRepo()
    const file = join(directory, "coolify.json")

    await updateProjectConfig(file, {
      projectUUID: "p1",
      applications: { web: { applicationUUID: "w1", path: "apps/web" } },
    })
    const config = await updateProjectConfig(file, {
      applications: { api: { applicationUUID: "a1", path: "apps/api" } },
      databases: { pg: { databaseUUID: "d1", type: "postgresql" } },
    })

    expect(config.projectUUID).toBe("p1")
    expect(Object.keys(config.applications).sort()).toEqual(["api", "web"])
    expect(config.databases.pg?.type).toBe("postgresql")

    // Still valid JSON on disk, with a trailing newline.
    const raw = await readFile(file, "utf8")
    expect(raw.endsWith("\n")).toBe(true)
    expect(JSON.parse(raw).projectUUID).toBe("p1")
  })

  it("preserves unknown top-level keys", async () => {
    const directory = await tempRepo()
    const file = join(directory, "coolify.json")
    await writeFile(file, JSON.stringify({ context: "production", projectUUID: "old" }), "utf8")

    const config = await updateProjectConfig(file, { projectUUID: "new" })
    expect(config.projectUUID).toBe("new")
    expect(JSON.parse(await readFile(file, "utf8")).context).toBe("production")
  })
})

describe("path helpers", () => {
  it("normalizes and compares repo-relative paths", () => {
    expect(normalizePath("./apps/web/")).toBe("apps/web")
    expect(isWithin("apps/web/admin", "apps/web")).toBe(true)
    expect(isWithin("apps/web", "apps/web")).toBe(true)
    expect(isWithin("apps/webbish", "apps/web")).toBe(false)
    expect(isWithin("anything", ".")).toBe(true)
  })
})

describe("validateProjectJson", () => {
  it("accepts an applications map with uuids", () => {
    expect(validateProjectJson({ applications: { web: { applicationUUID: "app_1" } } })).toBeUndefined()
  })

  it("accepts the single-application and project-only shorthands", () => {
    expect(validateProjectJson({ applicationUUID: "app_1" })).toBeUndefined()
    expect(validateProjectJson({ projectUUID: "proj_1" })).toBeUndefined()
  })

  it("rejects a config that names no application at all", () => {
    // Otherwise the sidebar would resolve nothing and say nothing about why.
    expect(validateProjectJson({ unrelated: true })).toContain("applications")
    expect(validateProjectJson({ applicationUUID: "   " })).toContain("applications")
  })

  it("rejects a malformed applications map", () => {
    expect(validateProjectJson({ applications: [] })).toContain("must be an object")
    expect(validateProjectJson({ applications: { web: "app_1" } })).toContain("applications.web")
    expect(validateProjectJson({ applications: { web: { name: "web" } } })).toContain("applicationUUID")
    expect(validateProjectJson({ applications: { web: { applicationUUID: "" } } })).toContain("applicationUUID")
  })

  it("rejects a malformed databases map", () => {
    expect(validateProjectJson({ projectUUID: "p", databases: "nope" })).toContain("databases")
  })
})
