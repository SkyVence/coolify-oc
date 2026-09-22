import { describe, expect, it } from "vitest"
import { databaseRuntime, isDatabaseType, normalizeDatabaseList } from "../src/coolify/databases"

describe("isDatabaseType", () => {
  it("accepts the supported engines and rejects others", () => {
    expect(isDatabaseType("postgresql")).toBe(true)
    expect(isDatabaseType("dragonfly")).toBe(true)
    expect(isDatabaseType("sqlite")).toBe(false)
    expect(isDatabaseType(undefined)).toBe(false)
  })
})

describe("normalizeDatabaseList", () => {
  it("accepts a flat array", () => {
    const result = normalizeDatabaseList([{ uuid: "d1", name: "acme" }])
    expect(result).toHaveLength(1)
    expect(result[0]?.uuid).toBe("d1")
  })

  it("accepts a wrapped array", () => {
    expect(normalizeDatabaseList({ databases: [{ uuid: "d1" }] })).toHaveLength(1)
    expect(normalizeDatabaseList({ data: [{ uuid: "d1" }] })).toHaveLength(1)
  })

  it("accepts a JSON string, which the documented schema claims", () => {
    expect(normalizeDatabaseList(JSON.stringify([{ uuid: "d1" }]))).toHaveLength(1)
    expect(normalizeDatabaseList("not json")).toEqual([])
  })

  it("recovers the type from a grouping key", () => {
    const result = normalizeDatabaseList({ postgresql: [{ uuid: "d1", name: "acme" }], redis: [{ uuid: "d2" }] })
    expect(result.map((entry) => entry.type)).toEqual(["postgresql", "redis"])
  })

  it("maps the field aliases Coolify has used", () => {
    const result = normalizeDatabaseList([
      {
        uuid: "d1",
        database_type: "mysql",
        project: { uuid: "p1" },
        environment: { name: "production" },
      },
    ])
    expect(result[0]).toMatchObject({ type: "mysql", project_uuid: "p1", environment_name: "production" })
  })

  it("degrades to an empty list for unexpected payloads", () => {
    expect(normalizeDatabaseList(undefined)).toEqual([])
    expect(normalizeDatabaseList(42)).toEqual([])
    expect(normalizeDatabaseList({ nope: "value" })).toEqual([])
  })
})

describe("databaseRuntime", () => {
  it("reuses the container status parser", () => {
    expect(databaseRuntime({ status: "running:healthy" }).label).toBe("running (healthy)")
    expect(databaseRuntime({}).label).toBe("unknown")
  })
})
