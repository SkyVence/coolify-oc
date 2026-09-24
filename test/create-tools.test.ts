import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { applicationKey, inspectPackage } from "../packages/server/src/tools/create"
import { parseProjectConfig } from "../packages/server/src/project-config"

async function packageDir(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coolify-inspect-"))
  for (const [name, content] of Object.entries(files)) {
    const path = join(directory, name)
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, content, "utf8")
  }
  return directory
}

describe("inspectPackage", () => {
  it("prefers a compose file and reads published ports", async () => {
    const directory = await packageDir({
      "docker-compose.yml": ["services:", "  web:", "    image: nginx", "    ports:", '      - "8080:80"'].join("\n"),
    })
    const result = await inspectPackage(directory, "")
    expect(result.buildPack).toBe("dockercompose")
    expect(result.portsExposes).toBe("8080")
    expect(result.dockerComposeLocation).toBe("/docker-compose.yml")
  })

  it("detects a Dockerfile and its EXPOSE", async () => {
    const directory = await packageDir({ Dockerfile: "FROM node:22\nEXPOSE 3000\nEXPOSE 9229/tcp\n" })
    const result = await inspectPackage(directory, "")
    expect(result.buildPack).toBe("dockerfile")
    expect(result.portsExposes).toBe("3000,9229")
    expect(result.dockerfileLocation).toBe("/Dockerfile")
  })

  it("falls back to nixpacks when there is a package.json but no container files", async () => {
    const directory = await packageDir({ "package.json": "{}" })
    const result = await inspectPackage(directory, "")
    expect(result.buildPack).toBe("nixpacks")
    expect(result.portsExposes).toBeUndefined()
    expect(result.hasPackageJson).toBe(true)
  })

  it("uses the monorepo package path as the base directory and looks inside it", async () => {
    const directory = await packageDir({ "apps/api/Dockerfile": "FROM node:22\nEXPOSE 4000\n" })
    const result = await inspectPackage(directory, "apps/api")
    expect(result.baseDirectory).toBe("/apps/api")
    expect(result.dockerfileLocation).toBe("/apps/api/Dockerfile")
    expect(result.portsExposes).toBe("4000")
  })

  it("degrades instead of throwing when the path does not exist", async () => {
    const directory = await packageDir({ "package.json": "{}" })
    const result = await inspectPackage(directory, "apps/missing")
    expect(result.buildPack).toBe("nixpacks")
    expect(result.reasons.join(" ")).toContain("could not read")
  })
})

describe("applicationKey", () => {
  const config = (applications: Record<string, unknown>) =>
    parseProjectConfig("/repo/coolify.json", JSON.stringify({ applications }))

  it("uses the package directory's basename", () => {
    expect(applicationKey(undefined, "new", "/apps/web", undefined)).toBe("web")
    expect(applicationKey(undefined, "new", "/", "Acme API")).toBe("acme-api")
  })

  it("falls back to a path slug when the basename is taken by another application", () => {
    const existing = config({ web: { applicationUUID: "other" } })
    expect(applicationKey(existing, "new", "/libs/web", undefined)).toBe("libs-web")
  })

  it("reuses the existing key when it already points at this application", () => {
    const existing = config({ web: { applicationUUID: "same" } })
    expect(applicationKey(existing, "same", "/apps/web", undefined)).toBe("web")
  })
})
