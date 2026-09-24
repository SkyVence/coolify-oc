import { describe, expect, it } from "vitest"
import { CoolifyClient, normalizeEndpoint } from "../packages/server/src/coolify/client"
import { CoolifyError } from "../packages/server/src/coolify/types"
import { makeFetch } from "./helpers"

describe("normalizeEndpoint", () => {
  it("adds a scheme and the api version path", () => {
    expect(normalizeEndpoint("coolify.example.com")).toBe("https://coolify.example.com/api/v1")
  })

  it("keeps an explicit scheme and strips a trailing slash", () => {
    expect(normalizeEndpoint("http://coolify.example.com/")).toBe("http://coolify.example.com/api/v1")
  })

  it("does not duplicate /api/v1", () => {
    expect(normalizeEndpoint("https://coolify.example.com/api/v1")).toBe("https://coolify.example.com/api/v1")
  })

  it("honours a sub-path deployment", () => {
    expect(normalizeEndpoint("https://host/coolify")).toBe("https://host/coolify/api/v1")
  })

  it("rejects an empty endpoint", () => {
    expect(() => normalizeEndpoint("   ")).toThrow()
  })
})

describe("CoolifyClient", () => {
  it("sends bearer auth and parses JSON", async () => {
    const { fetch, calls } = makeFetch([{ method: "GET", path: "/projects", status: 200, body: [{ uuid: "p1" }] }])
    const client = new CoolifyClient({ endpoint: "coolify.test", token: "secret", fetch })
    const result = await client.get<{ uuid: string }[]>("/projects")
    expect(result).toEqual([{ uuid: "p1" }])
    expect(calls[0]?.url).toBe("https://coolify.test/api/v1/projects")
  })

  it("classifies a 403 as forbidden", async () => {
    const { fetch } = makeFetch([{ method: "PATCH", path: "/applications/a1", status: 403, body: { message: "No" } }])
    const client = new CoolifyClient({ endpoint: "coolify.test", token: "secret", fetch })
    await expect(client.patch("/applications/a1", { body: {} })).rejects.toMatchObject({
      kind: "forbidden",
      status: 403,
    })
  })

  it("distinguishes a missing sensitive permission", async () => {
    const { fetch } = makeFetch([
      { method: "GET", path: "/applications/a1/envs", status: 403, body: { message: "Missing sensitive permission" } },
    ])
    const client = new CoolifyClient({ endpoint: "coolify.test", token: "secret", fetch })
    await expect(client.get("/applications/a1/envs")).rejects.toMatchObject({ kind: "missing_sensitive" })
  })

  it("reports the denied ability when a request carries a requirement", async () => {
    const denied: string[] = []
    const { fetch } = makeFetch([{ method: "POST", path: "/deploy", status: 403, body: { message: "No" } }])
    const client = new CoolifyClient({
      endpoint: "coolify.test",
      token: "secret",
      fetch,
      onDenied: (event) => denied.push(event.capability),
    })
    await expect(client.post("/deploy", { requires: "deploy" })).rejects.toBeInstanceOf(CoolifyError)
    expect(denied).toEqual(["deploy"])
  })

  it("surfaces an unreachable host as a network error", async () => {
    const fetch = (async () => {
      throw new Error("connect ECONNREFUSED")
    }) as typeof globalThis.fetch
    const client = new CoolifyClient({ endpoint: "coolify.test", token: "secret", fetch })
    await expect(client.get("/projects")).rejects.toMatchObject({ kind: "network" })
  })
})

describe("CoolifyClient retries", () => {
  it("retries a GET that hits a 5xx, then succeeds", async () => {
    let calls = 0
    const fetch = (async () => {
      calls += 1
      if (calls === 1) return new Response(JSON.stringify({ message: "boom" }), { status: 503 })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof globalThis.fetch

    const client = new CoolifyClient({ endpoint: "coolify.test", token: "t", fetch })
    await expect(client.get("/projects")).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it("never retries a write, because a repeated POST is not idempotent", async () => {
    let calls = 0
    const fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ message: "boom" }), { status: 500 })
    }) as typeof globalThis.fetch

    const client = new CoolifyClient({ endpoint: "coolify.test", token: "t", fetch })
    await expect(client.post("/deploy", { body: {}, requires: "deploy" })).rejects.toMatchObject({ kind: "server" })
    expect(calls).toBe(1)
  })

  it("gives up after the configured number of retries", async () => {
    let calls = 0
    const fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ message: "boom" }), { status: 500 })
    }) as typeof globalThis.fetch

    const client = new CoolifyClient({ endpoint: "coolify.test", token: "t", fetch, retries: 1 })
    await expect(client.get("/projects")).rejects.toMatchObject({ kind: "server" })
    expect(calls).toBe(2)
  })

  it("does not retry a 4xx that is not a rate limit", async () => {
    let calls = 0
    const fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ message: "No" }), { status: 403 })
    }) as typeof globalThis.fetch

    const client = new CoolifyClient({ endpoint: "coolify.test", token: "t", fetch })
    await expect(client.get("/projects")).rejects.toMatchObject({ kind: "forbidden" })
    expect(calls).toBe(1)
  })
})
