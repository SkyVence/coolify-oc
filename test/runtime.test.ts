import { describe, expect, it } from "vitest"
import { parseApplicationStatus, runtimeTone } from "../packages/shared/src/coolify/runtime"

describe("parseApplicationStatus", () => {
  it("splits state and health", () => {
    expect(parseApplicationStatus("running:healthy")).toMatchObject({
      state: "running",
      health: "healthy",
      label: "running (healthy)",
    })
    expect(parseApplicationStatus("running:unhealthy")).toMatchObject({
      state: "running",
      health: "unhealthy",
      label: "running (unhealthy)",
    })
    expect(parseApplicationStatus("restarting:unhealthy")).toMatchObject({
      state: "restarting",
      health: "unhealthy",
      label: "restarting (unhealthy)",
    })
  })

  it("handles a bare state", () => {
    expect(parseApplicationStatus("exited")).toMatchObject({ state: "exited", health: "none", label: "exited" })
    expect(parseApplicationStatus("starting")).toMatchObject({ state: "starting", label: "starting" })
  })

  it("maps the container-state synonyms", () => {
    expect(parseApplicationStatus("killed").state).toBe("exited")
    expect(parseApplicationStatus("dead").state).toBe("exited")
    expect(parseApplicationStatus("up").state).toBe("running")
    expect(parseApplicationStatus("created").state).toBe("starting")
  })

  it("handles a health-only value", () => {
    expect(parseApplicationStatus("unhealthy")).toMatchObject({ state: "unknown", health: "unhealthy", label: "unhealthy" })
  })

  it("treats a missing health token as none", () => {
    expect(parseApplicationStatus("running:unknown").health).toBe("none")
    expect(parseApplicationStatus("running:unknown").label).toBe("running")
  })

  it("is case-insensitive", () => {
    expect(parseApplicationStatus("RUNNING:HEALTHY").state).toBe("running")
  })

  it("degrades unknown values instead of throwing", () => {
    expect(parseApplicationStatus("some-future-state").state).toBe("unknown")
    expect(parseApplicationStatus("").label).toBe("unknown")
    expect(parseApplicationStatus(undefined).label).toBe("unknown")
    expect(parseApplicationStatus(null).label).toBe("unknown")
  })
})

describe("runtimeTone", () => {
  const tone = (raw: string) => runtimeTone(parseApplicationStatus(raw))

  it("maps states to severity", () => {
    expect(tone("running:healthy")).toBe("ok")
    expect(tone("running:unknown")).toBe("ok")
    expect(tone("running:unhealthy")).toBe("warn")
    expect(tone("starting")).toBe("warn")
    expect(tone("restarting:unhealthy")).toBe("warn")
    expect(tone("paused")).toBe("warn")
    expect(tone("degraded:unhealthy")).toBe("warn")
    expect(tone("exited")).toBe("bad")
    expect(tone("killed")).toBe("bad")
    expect(tone("unhealthy")).toBe("bad")
    expect(tone("")).toBe("unknown")
    expect(tone("mystery")).toBe("unknown")
  })
})
