import { describe, expect, it } from "vitest"
import {
  DEFAULT_REFRESH_SECONDS,
  MAX_REFRESH_SECONDS,
  MIN_REFRESH_SECONDS,
  parseRecursiveProjects,
  parseRefreshSeconds,
} from "../packages/shared/src/options"

describe("parseRefreshSeconds", () => {
  it("defaults to 25 seconds", () => {
    expect(DEFAULT_REFRESH_SECONDS).toBe(25)
    expect(parseRefreshSeconds(undefined)).toBe(25)
  })

  it("accepts integers across the allowed range", () => {
    expect(parseRefreshSeconds(MIN_REFRESH_SECONDS)).toBe(5)
    expect(parseRefreshSeconds(25)).toBe(25)
    expect(parseRefreshSeconds(MAX_REFRESH_SECONDS)).toBe(600)
  })

  it("ignores anything outside the range or not an integer", () => {
    expect(parseRefreshSeconds(4)).toBe(25)
    expect(parseRefreshSeconds(601)).toBe(25)
    expect(parseRefreshSeconds(25.5)).toBe(25)
    expect(parseRefreshSeconds(Number.NaN)).toBe(25)
    expect(parseRefreshSeconds(Number.POSITIVE_INFINITY)).toBe(25)
  })

  it("ignores non-numeric values", () => {
    expect(parseRefreshSeconds("25")).toBe(25)
    expect(parseRefreshSeconds(null)).toBe(25)
    expect(parseRefreshSeconds(true)).toBe(25)
    expect(parseRefreshSeconds({})).toBe(25)
  })
})

describe("parseRecursiveProjects", () => {
  it("is off unless explicitly true", () => {
    expect(parseRecursiveProjects(undefined)).toBe(false)
    expect(parseRecursiveProjects(false)).toBe(false)
    expect(parseRecursiveProjects("true")).toBe(false)
    expect(parseRecursiveProjects(1)).toBe(false)
    expect(parseRecursiveProjects(true)).toBe(true)
  })
})
