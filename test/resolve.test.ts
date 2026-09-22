import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CoolifyClient } from "../src/coolify/client"
import { matchGitRepository, normalizeGitUrl, normalizeName, readGitRemote, resolveProject } from "../src/resolve"
import { linkKey, writeLink } from "../src/store"
import { makeFetch, memoryStore, projectWithConfig, projectWithGitRemote, report } from "./helpers"

const PROJECT_ID = "proj_test"

function clientFor(applications: readonly unknown[]) {
  const fake = makeFetch([
    { method: "GET", path: "/applications", status: 200, body: applications },
  ])
  return new CoolifyClient({ endpoint: "coolify.test", token: "secret", fetch: fake.fetch })
}

describe("normalizeGitUrl", () => {
  it("normalizes the common spellings to host/owner/repo", () => {
    expect(normalizeGitUrl("git@github.com:acme/app.git")).toBe("github.com/acme/app")
    expect(normalizeGitUrl("https://github.com/acme/app.git")).toBe("github.com/acme/app")
    expect(normalizeGitUrl("https://github.com/acme/app")).toBe("github.com/acme/app")
    expect(normalizeGitUrl("ssh://git@gitlab.com/acme/app.git")).toBe("gitlab.com/acme/app")
    expect(normalizeGitUrl("https://github.com/Acme/App/")).toBe("github.com/acme/app")
  })
})

describe("matchGitRepository", () => {
  it("matches full URLs exactly", () => {
    expect(matchGitRepository("https://github.com/acme/app.git", "git@github.com:acme/app.git")).toBe("exact")
  })

  it("matches Coolify's short owner/repo form against a full remote", () => {
    // Real case: Coolify stored `SkyVence/yquest` while the checkout reported
    // `https://github.com/SkyVence/yquest.git`.
    expect(matchGitRepository("SkyVence/yquest", "https://github.com/SkyVence/yquest.git")).toBe("path")
    expect(matchGitRepository("acme/app", "git@gitlab.com:acme/app.git")).toBe("path")
  })

  it("does not match different repositories", () => {
    expect(matchGitRepository("acme/app", "https://github.com/acme/other.git")).toBe("none")
    expect(matchGitRepository(undefined, "https://github.com/acme/app.git")).toBe("none")
    expect(matchGitRepository("", "")).toBe("none")
  })

  it("does not treat two full URLs on different hosts as a match", () => {
    expect(matchGitRepository("https://github.com/acme/app", "https://gitlab.com/acme/app")).toBe("none")
  })
})

describe("normalizeName", () => {
  it("collapses punctuation and case", () => {
    expect(normalizeName("My-App_2")).toBe("myapp2")
  })
})

describe("readGitRemote", () => {
  it("reads the origin url from .git/config", async () => {
    const directory = await projectWithGitRemote("git@github.com:acme/app.git")
    expect(await readGitRemote(directory)).toBe("git@github.com:acme/app.git")
  })

  it("returns undefined when there is no repository", async () => {
    expect(await readGitRemote("/tmp")).toBeUndefined()
  })
})

describe("resolveProject", () => {
  it("prefers the git remote over the directory name", async () => {
    const directory = await projectWithGitRemote("git@github.com:acme/app.git")
    const client = clientFor([
      { uuid: "other", name: "app", git_repository: "https://github.com/acme/other" },
      { uuid: "match", name: "unrelated", git_repository: "git@github.com:acme/app.git" },
    ])

    const resolution = await resolveProject({
      store: memoryStore(),
      projectID: PROJECT_ID,
      directory,
      client,
      capabilities: report({ read: "granted" }),
    })

    expect(resolution.source).toBe("discovered")
    expect(resolution.best?.applicationUUID).toBe("match")
    expect(resolution.candidates[0]?.score).toBe(100)
  })

  it("refuses to choose when the best candidates tie", async () => {
    const directory = await projectWithGitRemote("git@github.com:acme/app.git")
    const client = clientFor([
      { uuid: "one", name: "app", git_repository: "git@github.com:acme/app.git" },
      { uuid: "two", name: "app", git_repository: "https://github.com/acme/app.git" },
    ])

    const resolution = await resolveProject({
      store: memoryStore(),
      projectID: PROJECT_ID,
      directory,
      client,
      capabilities: report({ read: "granted" }),
    })

    expect(resolution.ambiguous).toBe(true)
    expect(resolution.best).toBeUndefined()
    expect(resolution.source).toBe("none")
  })

  it("returns nothing useful without the read ability", async () => {
    const directory = await projectWithGitRemote("git@github.com:acme/app.git")
    const resolution = await resolveProject({
      store: memoryStore(),
      projectID: PROJECT_ID,
      directory,
      client: clientFor([]),
      capabilities: report({ read: "denied" }),
    })

    expect(resolution.source).toBe("none")
    expect(resolution.notes.join(" ")).toContain("read")
  })

  it("uses a .coolify.json before discovery", async () => {
    const directory = await projectWithConfig("from-config")
    const resolution = await resolveProject({
      store: memoryStore(),
      projectID: PROJECT_ID,
      directory,
      client: clientFor([{ uuid: "ignored", name: "app" }]),
      capabilities: report({ read: "granted" }),
    })

    expect(resolution.source).toBe("config")
    expect(resolution.best?.applicationUUID).toBe("from-config")
  })

  it("uses a pinned link before everything else", async () => {
    const directory = await projectWithGitRemote("git@github.com:acme/app.git")
    const store = memoryStore()
    await writeLink(store, PROJECT_ID, {
      applicationUUID: "pinned",
      name: "Pinned app",
      linkedAt: 1,
      source: "pin",
    })
    expect(store.data.has(linkKey(PROJECT_ID))).toBe(true)

    const resolution = await resolveProject({
      store,
      projectID: PROJECT_ID,
      directory,
      client: undefined,
      capabilities: undefined,
    })

    expect(resolution.source).toBe("pin")
    expect(resolution.best?.applicationUUID).toBe("pinned")
  })

  it("falls back to discovery when the pinned application no longer exists", async () => {    const directory = await projectWithGitRemote("git@github.com:acme/app.git")
    const store = memoryStore()
    await writeLink(store, PROJECT_ID, { applicationUUID: "gone", linkedAt: 1, source: "pin" })

    const fake = makeFetch([
      { method: "GET", path: "/applications", status: 200, body: [{ uuid: "fresh", name: "app", git_repository: "git@github.com:acme/app.git" }] },
      { method: "GET", path: "/applications/gone", status: 404, body: { message: "Not found" } },
    ])
    const client = new CoolifyClient({ endpoint: "coolify.test", token: "secret", fetch: fake.fetch })

    const resolution = await resolveProject({
      store,
      projectID: PROJECT_ID,
      directory,
      client,
      capabilities: report({ read: "granted" }),
    })

    expect(resolution.source).toBe("discovered")
    expect(resolution.best?.applicationUUID).toBe("fresh")
    expect(resolution.notes.join(" ")).toContain("no longer exists")
  })

  it("discovers an application that stores Coolify's short owner/repo form", async () => {
    // Mirrors a real instance: the app stores `SkyVence/yquest` while the local
    // checkout's origin is `https://github.com/SkyVence/yquest.git`, and Coolify
    // appends a suffix to the application name.
    const directory = await projectWithGitRemote("https://github.com/SkyVence/yquest.git")
    const client = clientFor([
      { uuid: "3dbia", name: "yquest:main-3dbia", git_repository: "SkyVence/yquest" },
      { uuid: "other", name: "api", git_repository: "coollabsio/coolify" },
    ])

    const resolution = await resolveProject({
      store: memoryStore(),
      projectID: PROJECT_ID,
      directory,
      client,
      capabilities: report({ read: "granted" }),
    })

    expect(resolution.source).toBe("discovered")
    expect(resolution.best?.applicationUUID).toBe("3dbia")
    expect(resolution.best?.reasons).toContain("git repository path")
  })

  it("produces scores that survive JSON round-tripping", async () => {    // A pinned link carries a synthetic score. RPC outputs are validated as
    // JSON, so a non-finite score would fail the call at the boundary.
    const directory = await projectWithGitRemote("git@github.com:acme/app.git")
    const store = memoryStore()
    await writeLink(store, PROJECT_ID, { applicationUUID: "pinned", linkedAt: 1, source: "pin" })

    const resolution = await resolveProject({
      store,
      projectID: PROJECT_ID,
      directory,
      client: undefined,
      capabilities: undefined,
    })

    const scores = [resolution.best?.score, ...resolution.candidates.map((candidate) => candidate.score)]
    for (const score of scores) {
      if (score === undefined) continue
      expect(Number.isFinite(score)).toBe(true)
    }
    expect(() => JSON.parse(JSON.stringify(resolution))).not.toThrow()
  })
})

describe("resolveProject with coolify.json", () => {
  async function monorepoRepo(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "coolify-mono-"))
    await mkdir(join(directory, ".git"), { recursive: true })
    await mkdir(join(directory, "apps", "web"), { recursive: true })
    await writeFile(
      join(directory, "coolify.json"),
      JSON.stringify({
        projectUUID: "proj_1",
        environmentName: "production",
        applications: {
          web: { applicationUUID: "web_uuid", path: "apps/web" },
          api: { applicationUUID: "api_uuid", path: "apps/api" },
        },
        databases: { postgres: { databaseUUID: "pg_uuid", type: "postgresql", path: "apps/web" } },
      }),
      "utf8",
    )
    return directory
  }

  it("wins over discovery and selects by directory", async () => {
    const directory = await monorepoRepo()
    const resolution = await resolveProject({
      store: memoryStore(),
      projectID: PROJECT_ID,
      directory: join(directory, "apps", "web"),
      // A client that would match something else, proving the config wins.
      client: clientFor([{ uuid: "other", name: "web", git_repository: "github.com/acme/web" }]),
      capabilities: report({ read: "granted" }),
    })

    expect(resolution.source).toBe("config")
    expect(resolution.best?.applicationUUID).toBe("web_uuid")
    expect(resolution.config?.projectUUID).toBe("proj_1")
    expect(resolution.config?.relativeFile).toBe("coolify.json")
    expect(Object.keys(resolution.config?.databases ?? {})).toEqual(["postgres"])
  })

  it("refuses to guess in a monorepo when no path matches", async () => {
    const directory = await monorepoRepo()
    const resolution = await resolveProject({
      store: memoryStore(),
      projectID: PROJECT_ID,
      directory,
      client: clientFor([{ uuid: "other", name: "whatever" }]),
      capabilities: report({ read: "granted" }),
    })

    expect(resolution.source).toBe("none")
    expect(resolution.ambiguous).toBe(true)
    expect(resolution.candidates).toHaveLength(2)
    expect(resolution.candidates.every((c) => c.reasons.some((r) => r.includes("coolify.json")))).toBe(true)
  })

  it("resolves without a client at all, which a deploy-only token needs", async () => {
    const directory = await monorepoRepo()
    const resolution = await resolveProject({
      store: memoryStore(),
      projectID: PROJECT_ID,
      directory: join(directory, "apps", "web"),
      client: undefined,
      capabilities: undefined,
    })

    expect(resolution.source).toBe("config")
    expect(resolution.link?.projectUUID).toBe("proj_1")
    expect(resolution.link?.environmentName).toBe("production")
  })
})
