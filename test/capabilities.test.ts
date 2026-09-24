import { describe, expect, it } from "vitest"
import { PROBE_UUID, probeCapabilities } from "../packages/server/src/coolify/capabilities"
import { CoolifyClient } from "../packages/server/src/coolify/client"
import { makeFetch, type FakeRoute } from "./helpers"

function clientFor(routes: readonly FakeRoute[]) {
  const fake = makeFetch(routes)
  const client = new CoolifyClient({ endpoint: "coolify.test", token: "secret", fetch: fake.fetch })
  return { client, calls: fake.calls }
}

const teamRoute: FakeRoute = { method: "GET", path: "/team", status: 200, body: { id: 1, name: "Acme" } }
const probeDelete: FakeRoute = { method: "DELETE", path: /\/applications\/opencode-probe-/, status: 404, body: { message: "Application not found." } }

describe("probeCapabilities", () => {
  it("reports every ability for a root token and infers likelyRoot", async () => {
    const { client } = clientFor([
      teamRoute,
      { method: "GET", path: "/projects", status: 200, body: [] },
      probeDelete,
      { method: "POST", path: "/deploy", status: 400, body: { message: "No resource specified." } },
    ])

    const report = await probeCapabilities(client)

    expect(report.probes.read.status).toBe("granted")
    expect(report.probes.write.status).toBe("granted")
    expect(report.probes.deploy.status).toBe("granted")
    expect(report.likelyRoot).toBe(true)
    expect(report.team).toEqual({ id: "1", name: "Acme" })
  })

  it("detects a read-only token", async () => {
    const { client } = clientFor([
      teamRoute,
      { method: "GET", path: "/projects", status: 200, body: [] },
      { method: "DELETE", path: /\/applications\/opencode-probe-/, status: 403, body: { message: "No" } },
      { method: "POST", path: "/deploy", status: 403, body: { message: "No" } },
    ])

    const report = await probeCapabilities(client)

    expect(report.probes.read.status).toBe("granted")
    expect(report.probes.write.status).toBe("denied")
    expect(report.probes.deploy.status).toBe("denied")
    expect(report.likelyRoot).toBe(false)
  })

  it("detects a deploy-only token and explains the consequence", async () => {
    const { client } = clientFor([
      teamRoute,
      { method: "GET", path: "/projects", status: 403, body: { message: "No" } },
      { method: "DELETE", path: /\/applications\/opencode-probe-/, status: 403, body: { message: "No" } },
      { method: "POST", path: "/deploy", status: 400, body: { message: "No resource specified." } },
    ])

    const report = await probeCapabilities(client)

    expect(report.probes.read.status).toBe("denied")
    expect(report.probes.deploy.status).toBe("granted")
    expect(report.notes.some((note) => note.includes("deploy-only"))).toBe(true)
  })

  it("never mutates a real resource: the write probe targets a sentinel UUID", async () => {
    const { client, calls } = clientFor([
      teamRoute,
      { method: "GET", path: "/projects", status: 200, body: [] },
      probeDelete,
      { method: "POST", path: "/deploy", status: 400, body: { message: "No resource specified." } },
    ])

    await probeCapabilities(client)

    const deletes = calls.filter((call) => call.method === "DELETE")
    expect(deletes).toHaveLength(1)
    expect(deletes[0]?.url).toContain(PROBE_UUID)
    const deploys = calls.filter((call) => call.method === "POST" && call.url.includes("/deploy"))
    expect(deploys[0]?.url).toContain(PROBE_UUID)
  })

  it("throws on an invalid token rather than guessing abilities", async () => {
    const { client } = clientFor([
      { method: "GET", path: "/team", status: 401, body: { message: "Unauthenticated." } },
      { method: "GET", path: "/projects", status: 401, body: { message: "Unauthenticated." } },
    ])

    await expect(probeCapabilities(client)).rejects.toMatchObject({ kind: "unauthorized" })
  })

  it("leaves read:sensitive unknown until it is needed", async () => {
    const { client } = clientFor([
      teamRoute,
      { method: "GET", path: "/projects", status: 200, body: [] },
      probeDelete,
      { method: "POST", path: "/deploy", status: 400, body: { message: "No resource specified." } },
    ])

    const report = await probeCapabilities(client)
    expect(report.probes["read:sensitive"].status).toBe("unknown")
  })
})

describe("read:sensitive probing", () => {
  const base: FakeRoute[] = [
    teamRoute,
    { method: "GET", path: "/projects", status: 200, body: [] },
    probeDelete,
    { method: "POST", path: "/deploy", status: 400, body: { message: "No resource specified." } },
  ]

  it("reports granted when values come back unredacted", async () => {
    const { client } = clientFor([
      ...base,
      { method: "GET", path: "/applications", status: 200, body: [{ uuid: "a1" }] },
      { method: "GET", path: "/applications/a1/envs", status: 200, body: [{ key: "K", value: "real" }] },
    ])
    const report = await probeCapabilities(client)
    expect(report.probes["read:sensitive"].status).toBe("granted")
  })

  it("reports denied when values come back redacted", async () => {
    const { client } = clientFor([
      ...base,
      { method: "GET", path: "/applications", status: 200, body: [{ uuid: "a1" }] },
      { method: "GET", path: "/applications/a1/envs", status: 200, body: [{ key: "K", value: "********" }] },
    ])
    const report = await probeCapabilities(client)
    expect(report.probes["read:sensitive"].status).toBe("denied")
  })

  it("stays unknown when there is nothing to compare, rather than guessing", async () => {
    const { client } = clientFor([
      ...base,
      { method: "GET", path: "/applications", status: 200, body: [{ uuid: "a1" }] },
      { method: "GET", path: "/applications/a1/envs", status: 200, body: [] },
    ])
    const report = await probeCapabilities(client)
    expect(report.probes["read:sensitive"].status).toBe("unknown")
    expect(report.probes["read:sensitive"].detail).toContain("no values to compare")
  })
})
