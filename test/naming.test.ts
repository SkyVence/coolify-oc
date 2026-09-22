import { describe, expect, it } from "vitest"
import { CoolifyClient } from "../src/coolify/client"
import { Coolify as CoolifyRpc } from "../src/rpc"
import { COOLIFY_SKILLS } from "../src/skills"
import { buildTools, type ToolDeps } from "../src/tools"
import { COOLIFY_ASPECTS, parseCoolifyArgument } from "../src/tui"
import { makeFetch, memoryStore } from "./helpers"

/**
 * The naming contract.
 *
 * Each surface below is a namespace with its own convention, and a name is meant
 * to identify exactly one action. These assertions exist because drift already
 * cost real confusion: "map" was at once a sidebar label, a slash command and a
 * skill, and two of the three meant different things.
 *
 * The rules are written out in NAMING.md. This file is what makes them stick —
 * prose does not fail a build.
 */

/** Every tier a tool may declare. Widening this is a permission-model change. */
const TIERS = new Set(["read", "write", "deploy", "destructive", "secrets"])

/**
 * Stems deliberately shared between namespaces, and why.
 *
 * A name should identify one action, but a tool and a skill are read in
 * different contexts and can describe the same outcome at different
 * granularities. Anything not listed here fails the test below, so a new
 * collision is a decision rather than an accident.
 */
const SHARED_STEMS: Readonly<Record<string, string>> = {
  link: "the skill and the tool both leave the project linked, by different means",
  deploy: "the skill orchestrates the deployment the tool performs",
}

/** `coolify_configure_project` and `coolify-configure-project` share a stem. */
const stem = (name: string): string => name.replace(/^coolify[-_]/, "").replace(/_/g, "-")

function toolDeps(): ToolDeps {
  const fake = makeFetch([])
  const granted = { status: "granted" as const, detail: "" }
  return {
    store: memoryStore(),
    projectID: "proj",
    directory: "/tmp",
    endpoint: "https://coolify.test",
    getClient: () => new CoolifyClient({ endpoint: "coolify.test", token: "secret", fetch: fake.fetch }),
    getCapabilities: () => ({
      endpoint: "https://coolify.test/api/v1",
      probes: { read: granted, write: granted, deploy: granted, "read:sensitive": granted },
      likelyRoot: true,
      checkedAt: 0,
      notes: [],
    }),
    getLink: () => undefined,
    setLink: async () => {},
    emitDeployProgress: () => {},
    emitProjectChanged: () => {},
  }
}

describe("naming: model tools", () => {
  const tools = buildTools(toolDeps())

  it("names every tool snake_case, with the namespace applied once", () => {
    for (const tool of tools) {
      expect(tool.name, tool.name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/)
      // The runtime prefixes `coolify_`; a name carrying it renders it twice.
      expect(tool.name.startsWith("coolify"), tool.name).toBe(false)
    }
  })

  it("has no duplicate tool names", () => {
    const names = tools.map((tool) => `coolify_${tool.name}`)
    expect(new Set(names).size).toBe(names.length)
  })

  it("only declares tiers from the closed set", () => {
    for (const tool of tools) expect(TIERS.has(tool.tier), `${tool.name}: ${tool.tier}`).toBe(true)
  })
})

describe("naming: skills", () => {
  it("names every skill coolify-kebab, uniquely", () => {
    for (const skill of COOLIFY_SKILLS) {
      expect(skill.id, skill.id).toMatch(/^coolify-[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    }
    const ids = COOLIFY_SKILLS.map((skill) => skill.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("gives every skill a description, which is what makes it discoverable", () => {
    // A skill with no description never reaches the model's skill guidance, so
    // it is registered but unusable.
    for (const skill of COOLIFY_SKILLS) {
      expect(skill.description.trim().length, skill.id).toBeGreaterThan(20)
      expect(skill.content.trim().length, skill.id).toBeGreaterThan(50)
    }
  })
})

describe("naming: one name, one action", () => {
  it("allows only the listed stems to be shared across namespaces", () => {
    const toolStems = new Set(buildTools(toolDeps()).map((tool) => stem(tool.name)))
    const candidates = [
      ...COOLIFY_SKILLS.map((skill) => skill.id),
      // Single-word aspects only: `link model` is a two-word phrase, not a stem.
      ...COOLIFY_ASPECTS.filter((entry) => !entry.name.includes(" ")).map((entry) => `coolify-${entry.name}`),
    ]

    for (const name of candidates) {
      const shared = stem(name)
      if (!toolStems.has(shared)) continue
      expect(SHARED_STEMS[shared], `${name} collides with a tool stem and is not declared`).toBeDefined()
    }
  })

  it("declares no shared stem that is no longer shared", () => {
    // An allowlist entry that has outlived its collision is a comment pretending
    // to be a rule.
    const toolStems = new Set(buildTools(toolDeps()).map((tool) => stem(tool.name)))
    const candidates = [
      ...COOLIFY_SKILLS.map((skill) => stem(skill.id)),
      ...COOLIFY_ASPECTS.filter((entry) => !entry.name.includes(" ")).map((entry) => entry.name),
    ]
    for (const declared of Object.keys(SHARED_STEMS)) {
      expect(toolStems.has(declared), `${declared} is allowlisted but collides with nothing`).toBe(true)
      expect(candidates.includes(declared), `${declared} is allowlisted but no longer used`).toBe(true)
    }
  })
})

describe("naming: the aspect table is the contract", () => {
  it("routes every documented aspect to the handler it declares", () => {
    for (const entry of COOLIFY_ASPECTS) {
      expect(parseCoolifyArgument(entry.name), entry.name).toBe(entry.aspect)
    }
  })

  it("declares each aspect name and each handler once", () => {
    const names = COOLIFY_ASPECTS.map((entry) => entry.name)
    const aspects = COOLIFY_ASPECTS.map((entry) => entry.aspect)
    expect(new Set(names).size).toBe(names.length)
    expect(new Set(aspects).size).toBe(aspects.length)
  })

  it("never declares the fallbacks as reachable aspects", () => {
    const aspects = COOLIFY_ASPECTS.map((entry) => entry.aspect)
    expect(aspects).not.toContain("hub")
    expect(aspects).not.toContain("unknown")
  })
})

describe("naming: the RPC surface", () => {
  const methods = Object.entries(CoolifyRpc.methods)

  it("names every method camelCase", () => {
    for (const [name] of methods) expect(name, name).toMatch(/^[a-z][a-zA-Z0-9]*$/)
  })

  it("declares an input and an output schema for every method", () => {
    // Without an output schema the runtime silently drops the field, which is
    // how `recursiveProjects` went missing once already.
    for (const [name, method] of methods) {
      expect(method.input, `${name} input`).toBeDefined()
      expect(method.output, `${name} output`).toBeDefined()
    }
  })
})
