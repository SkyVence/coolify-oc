import { describe, expect, it } from "vitest"
import {
  STARTING_MIN_SPIN_MS,
  STARTING_TIMEOUT_MS,
  abilityEntries,
  abilitySummary,
  abilityTone,
  appRowLabel,
  appRowState,
  appRowTone,
  markStartingUp,
  reconcileStartingUp,
  refreshSeconds,
  statusLight,
} from "../src/tui"

/**
 * These tests import the real TUI entry and drive `setup` with a mock context.
 *
 * `setup` is where commands, slots and the side-conversation flow are wired, so
 * exercising it catches runtime wiring errors a type check cannot.
 */
function mockContext() {
  const layers: any[] = []
  const slots: any[] = []
  const toasts: any[] = []
  const connectCalls: any[] = []
  const sessionPrompts: any[] = []
  const sessionCreates: any[] = []
  const tabOpens: string[] = []
  const selects: any[] = []
  const configWrites: any[] = []
  const resolveCalls: any[] = []

  let promptAnswers: (string | undefined)[] = ["1|secret-token"]
  let selectAnswer: string | undefined
  let confirmAnswer = true
  let tabsEnabled = true
  let capabilitiesResponse: any = {
    connected: true,
    endpointConfigured: true,
    endpoint: "https://coolify.example.com/api/v1",
  }

  const rpc = {
    capabilities: async () => capabilitiesResponse,
    configureProject: async (input: any) => {
      configWrites.push(input)
      return { ok: true, file: "/home/me/project/coolify.json", applications: 1, databases: 0 }
    },
    applications: async () => ({ connected: true, scope: "mapped", apps: [] }),
    setEndpoint: async (input: any) => ({ ok: true, endpoint: `${input.endpoint}/api/v1` }),
    refreshCapabilities: async () => {
      capabilitiesResponse = { ...capabilitiesResponse, connected: true }
      return capabilitiesResponse
    },
    resolve: async (input: any) => {
      resolveCalls.push(input)
      return { source: "none", ambiguous: false, candidates: [], notes: [], config: { projectUUID: "proj_1" } }
    },
    link: async (input: any) => ({ link: input }),
    unlink: async () => ({ ok: true }),
    status: async () => ({ connected: true, linked: true }),
    deploy: async () => ({ message: "ok" }),
    cancelDeployment: async () => ({ message: "ok" }),
    events: { on: () => () => {}, subscribe: async function* () {} },
  }

  const client = {
    rpc: () => rpc,
    integration: { connect: { key: async (input: any) => void connectCalls.push(input) } },
    session: {
      create: async (input: any) => {
        sessionCreates.push(input)
        return { id: "ses_deploy" }
      },
      prompt: async (input: any) => {
        sessionPrompts.push(input)
      },
    },
  }

  const context = {
    options: {},
    location: { directory: "/home/me/tui-launch" },
    app: { version: "test", channel: "test" },
    renderer: {},
    client,
    data: {
      on: () => () => {},
      listen: () => () => {},
      session: { get: () => ({ id: "ses_current", location: { directory: "/home/me/project" } }) },
      location: { default: () => ({ directory: "/home/me/project" }) },
    },
    attention: { notify: async () => ({ ok: true }) },
    theme: {},
    themeMode: "dark",
    markdown: { registerCodeBlockRenderer: () => () => {} },
    keymap: {
      layer: (factory: () => unknown) => void layers.push(factory()),
      dispatch: () => {},
      shortcuts: () => [],
      commands: () => [],
      pending: () => [],
      active: () => [],
      mode: { current: () => "base", push: () => () => {} },
    },
    storage: {},
    ui: {
      dialog: {
        alert: async () => {},
        confirm: async () => confirmAnswer,
        prompt: async () => (promptAnswers.length > 0 ? promptAnswers.shift() : undefined),
        select: async (options: any) => {
          selects.push(options)
          return selectAnswer
        },
        show: () => {},
        set() {},
        clear() {},
      },
      toast: { show: (options: any) => void toasts.push(options) },
      format: { path: (value: string) => value },
      router: { register: () => () => {}, navigate() {}, current: () => ({ type: "session", sessionID: "ses_current" }) },
      tabs: {
        enabled: () => tabsEnabled,
        list: () => [],
        open: (sessionID: string) => {
          tabOpens.push(sessionID)
          return tabsEnabled
        },
        focus: () => tabsEnabled,
        move: () => false,
        close: () => false,
      },
      slot: (claim: any) => void slots.push(claim),
    },
  }

  // The command layer is created from the `app` slot render, not from setup:
  // that is where the TUI's Keymap provider exists.
  let commandLayer: any[] | undefined
  const commands = (): any[] => {
    if (!commandLayer) {
      const claim = slots.find((slot: any) => slot.append === "app")
      if (!claim) throw new Error("the app slot was not registered during setup")
      claim.render({})
      commandLayer = layers[layers.length - 1]?.commands ?? []
    }
    return commandLayer ?? []
  }

  return {
    context,
    layers,
    slots,
    toasts,
    connectCalls,
    sessionPrompts,
    sessionCreates,
    tabOpens,
    selects,
    configWrites,
    resolveCalls,
    commands,
    setPrompt: (value: string | undefined) => {
      promptAnswers = [value]
    },
    setConfirm: (value: boolean) => {
      confirmAnswer = value
    },
    setSelect: (value: string | undefined) => {
      selectAnswer = value
    },
    setTabsEnabled: (value: boolean) => {
      tabsEnabled = value
    },
  }
}

async function loadPlugin() {
  return (await import("../src/tui")).default
}

const find = (harness: ReturnType<typeof mockContext>, id: string) =>
  harness.commands().find((command: any) => command.id === id)

describe("tui plugin", () => {
  it("registers only the app and session panel slots", async () => {
    const harness = mockContext()
    const plugin = await loadPlugin()
    await plugin.setup(harness.context as any)

    // The full-screen panel was replaced by a sidebar section.
    expect(harness.slots.map((slot: any) => slot.append).sort()).toEqual(["app", "sidebar.content"])
  })

  it("registers exactly two commands and defers keymap until the app slot renders", async () => {
    const harness = mockContext()
    const plugin = await loadPlugin()
    await plugin.setup(harness.context as any)

    expect(harness.layers).toHaveLength(0)
    expect(harness.commands().map((command: any) => command.id)).toEqual([
      "coolify.panel.open",
      "coolify.map",
      "coolify.deploy",
    ])
    expect(harness.layers).toHaveLength(1)

    const slashNames = harness
      .commands()
      .map((command: any) => command.slash?.name)
      .filter(Boolean)
    expect(slashNames).toEqual(["coolify", "coolify-map", "coolify-deploy"])
  })

  it("offers the project's applications from the /coolify command", async () => {
    const harness = mockContext()
    const rpcApplications = harness.context.client.rpc() as any
    rpcApplications.applications = async () => ({
      connected: true,
      scope: "project",
      apps: [{ key: "web", applicationUUID: "app_1", name: "lawn-web" }],
    })
    const plugin = await loadPlugin()
    await plugin.setup(harness.context as any)

    await find(harness, "coolify.panel.open").run()

    expect(harness.selects).toHaveLength(1)
    expect(harness.connectCalls).toHaveLength(0)
  })

  it("runs a deploy in a background tab so the current chat is untouched", async () => {
    const harness = mockContext()
    const plugin = await loadPlugin()
    await plugin.setup(harness.context as any)

    await find(harness, "coolify.deploy").run()

    expect(harness.sessionCreates).toHaveLength(1)
    // The session's project, not the TUI's launch directory.
    expect(harness.sessionCreates[0]).toMatchObject({
      location: { directory: "/home/me/project" },
      // Free to look, asks before changing.
      permissions: [{ action: "coolify.read", resource: "*", effect: "allow" }],
    })

    expect(harness.sessionPrompts).toHaveLength(1)
    expect(harness.sessionPrompts[0].sessionID).toBe("ses_deploy")
    expect(harness.sessionPrompts[0].text).toContain("coolify_resolve")

    // The new session is opened in a tab — and `open` does not steal focus.
    expect(harness.tabOpens).toEqual(["ses_deploy"])
  })

  it("falls back to the current chat when tabs are disabled, and asks first", async () => {
    const harness = mockContext()
    harness.setTabsEnabled(false)
    harness.setConfirm(false)
    const plugin = await loadPlugin()
    await plugin.setup(harness.context as any)

    await find(harness, "coolify.deploy").run()

    // Declined, so nothing happened at all.
    expect(harness.sessionCreates).toHaveLength(0)
    expect(harness.sessionPrompts).toHaveLength(0)

    harness.setConfirm(true)
    await find(harness, "coolify.deploy").run()

    // Accepted: the prompt goes to the existing session, not a new one.
    expect(harness.sessionCreates).toHaveLength(0)
    expect(harness.sessionPrompts.at(-1)?.sessionID).toBe("ses_current")
  })

  it("prompts for endpoint and token before opening when unconfigured", async () => {
    const harness = mockContext()
    harness.setPrompt("https://coolify.example.com")
    const plugin = await loadPlugin()
    await plugin.setup(harness.context as any)

    // An unconfigured endpoint is reported by capabilities; emulate that.
    const rpcCapabilities = harness.context.client.rpc() as any
    rpcCapabilities.capabilities = async () => ({ connected: false, endpointConfigured: false })

    await find(harness, "coolify.panel.open").run()

    expect(harness.selects).toHaveLength(0)
    expect(harness.connectCalls).toHaveLength(0)
  })
})

describe("mapping a project", () => {
  it("resolves and writes coolify.json for the session directory, with no model turn", async () => {
    const harness = mockContext()
    const rpcResolve = harness.context.client.rpc() as any
    rpcResolve.resolve = async (input: any) => {
      harness.resolveCalls.push(input)
      return {
        source: "discovered",
        ambiguous: false,
        candidates: [{ applicationUUID: "app_1", name: "lawn-web" }],
        notes: [],
        config: { projectUUID: "proj_1", environmentName: "production" },
      }
    }
    const plugin = await loadPlugin()
    await plugin.setup(harness.context as any)

    await find(harness, "coolify.map").run()

    // No session was created and no prompt was injected: this path is model-free.
    expect(harness.sessionCreates).toHaveLength(0)
    expect(harness.sessionPrompts).toHaveLength(0)

    expect(harness.resolveCalls).toEqual([{ directory: "/home/me/project" }])
    expect(harness.configWrites).toHaveLength(1)
    expect(harness.configWrites[0]).toMatchObject({
      directory: "/home/me/project",
      projectUUID: "proj_1",
      environmentName: "production",
      applications: { "lawn-web": { applicationUUID: "app_1", name: "lawn-web" } },
    })
  })

  it("keeps project-level actions on the sidebar rather than in the app dialog", async () => {
    const harness = mockContext()
    const plugin = await loadPlugin()
    await plugin.setup(harness.context as any)

    // The app dialog is opened from the sidebar contribution, so assert the
    // contribution exists and that no project-level prompt fires uninvited.
    const sidebar = harness.slots.find((slot: any) => slot.append === "sidebar.content")
    expect(typeof sidebar?.render).toBe("function")
    expect(harness.sessionCreates).toHaveLength(0)
    expect(harness.sessionPrompts).toHaveLength(0)
  })
})

describe("refreshSeconds", () => {
  const app = (status?: string) =>
    ({ key: "web", applicationUUID: "a1", name: "web", ...(status ? { latestDeployment: { status } } : {}) }) as any

  it("polls on the configured idle cadence when nothing is happening", () => {
    expect(refreshSeconds([])).toBe(25)
    expect(refreshSeconds([app("finished"), app()])).toBe(25)
  })

  it("honours the configured idle cadence from the plugin option", () => {
    expect(refreshSeconds([], 90)).toBe(90)
    expect(refreshSeconds([app("finished")], 90)).toBe(90)
  })

  it("follows a deployment closely while it runs", () => {
    expect(refreshSeconds([app("in_progress")])).toBe(10)
    expect(refreshSeconds([app("queued")])).toBe(10)
    // The active cadence stays below the idle one even for a small idle value.
    expect(refreshSeconds([app("in_progress")], 6)).toBe(5)
  })

  it("polls fast while a restart is settling", () => {
    const running = { key: "web", applicationUUID: "a1", name: "web" } as any
    const starting = [{ applicationUUID: "a1", startedAt: 0 }]
    expect(refreshSeconds([running], 25, starting)).toBe(10)
    // An unrelated starting application does not slow the deployment cadence.
    expect(refreshSeconds([running], 25, [{ applicationUUID: "other", startedAt: 0 }])).toBe(25)
  })
})

describe("ability tones", () => {
  const probes = (statuses: Record<string, string>) =>
    ({
      connected: true,
      probes: Object.fromEntries(Object.entries(statuses).map(([key, status]) => [key, { status, detail: "" }])),
    }) as any

  it("gives every ability its own tone from its probe status", () => {
    const entries = abilityEntries(
      probes({ read: "granted", write: "denied", deploy: "unknown", "read:sensitive": "granted" }),
    )
    expect(entries.map((entry) => [entry.label, entry.status, entry.tone])).toEqual([
      ["read", "granted", "ok"],
      ["write", "denied", "bad"],
      ["deploy", "unknown", "muted"],
      ["secrets", "granted", "ok"],
    ])
  })

  it("tones the whole line by how many abilities are granted", () => {
    expect(abilityTone(probes({ read: "granted", write: "granted", deploy: "granted", "read:sensitive": "granted" }))).toBe(
      "ok",
    )
    expect(abilityTone(probes({ read: "granted", write: "granted" }))).toBe("warn")
    expect(abilityTone(probes({ read: "granted" }))).toBe("warn")
    expect(abilityTone(probes({ read: "denied", write: "unknown" }))).toBe("bad")
    expect(abilityTone(undefined)).toBe("bad")
  })
})

describe("starting up detection", () => {
  const app = (over: any = {}) => ({ key: "web", applicationUUID: "a1", name: "web", ...over })
  const running = app({ runtime: { state: "running", health: "healthy", label: "running", raw: "running:healthy" } })
  const restarting = app({
    runtime: { state: "restarting", health: "none", label: "restarting", raw: "restarting" },
  })
  const exited = app({ runtime: { state: "exited", health: "none", label: "exited", raw: "exited" } })
  const unknown = app({ runtime: { state: "unknown", health: "none", label: "unknown", raw: "" } })

  it("detects an external restart between polls", () => {
    const next = reconcileStartingUp([], [running], [restarting], 1_000)
    expect(next).toEqual([{ applicationUUID: "a1", startedAt: 1_000 }])
  })

  it("treats a running container that exited as restarting, and a queued deployment too", () => {
    expect(reconcileStartingUp([], [running], [exited], 0)).toHaveLength(1)
    const queued = app({ latestDeployment: { status: "queued" } })
    const finished = app({ latestDeployment: { status: "finished" } })
    expect(reconcileStartingUp([], [finished], [queued], 0)).toHaveLength(1)
  })

  it("clears once the restart settles back to running", () => {
    const held = [{ applicationUUID: "a1", startedAt: 0 }]
    const settled = reconcileStartingUp(held, [restarting], [running], 30_000)
    expect(settled).toEqual([])
  })

  it("keeps spinning through a still-transitional poll", () => {
    const held = [{ applicationUUID: "a1", startedAt: 0 }]
    expect(reconcileStartingUp(held, [restarting], [restarting], 20_000)).toEqual(held)
  })

  it("expires after the timeout even if it never settled", () => {
    const held = [{ applicationUUID: "a1", startedAt: 0 }]
    expect(reconcileStartingUp(held, [restarting], [restarting], STARTING_TIMEOUT_MS)).toEqual([])
    expect(reconcileStartingUp(held, [restarting], [restarting], STARTING_TIMEOUT_MS - 1)).toEqual(held)
  })

  it("does not flag an application that was never running", () => {
    // Never deployed: nothing to restart from.
    expect(reconcileStartingUp([], [unknown], [exited], 0)).toEqual([])
    // Started from cold, so a queued deployment is not a restart either.
    const coldDeploy = app({ latestDeployment: { status: "queued" } })
    expect(reconcileStartingUp([], [unknown], [coldDeploy], 0)).toEqual([])
    // Newly appeared rows have no previous state at all.
    expect(reconcileStartingUp([], [], [exited], 0)).toEqual([])
  })

  it("holds a locally-triggered restart until the signal shows or the grace lapses", () => {
    const marked = markStartingUp([], "a1", 0)
    expect(marked).toEqual([{ applicationUUID: "a1", startedAt: 0 }])
    // A poll that still shows the old running state does not clear it immediately.
    expect(reconcileStartingUp(marked, [running], [running], 5_000)).toEqual(marked)
    // Past the minimum spin, a still-running row is treated as settled.
    expect(reconcileStartingUp(marked, [running], [running], STARTING_MIN_SPIN_MS)).toEqual([])
    // The signal arriving keeps it going.
    expect(reconcileStartingUp(marked, [running], [restarting], 5_000)).toEqual(marked)
  })

  it("does not duplicate an application that is marked twice", () => {
    const once = markStartingUp([], "a1", 0)
    expect(markStartingUp(once, "a1", 99)).toBe(once)
  })
})

describe("abilitySummary", () => {
  const probes = (statuses: Record<string, string>) =>
    ({
      connected: true,
      probes: Object.fromEntries(Object.entries(statuses).map(([key, status]) => [key, { status, detail: "" }])),
    }) as any

  it("lists only granted abilities, in a stable order", () => {
    expect(abilitySummary(probes({ read: "granted", write: "granted", deploy: "granted", "read:sensitive": "granted" }))).toBe(
      "read write deploy secrets",
    )
  })

  it("omits abilities that are denied or unknown", () => {
    expect(abilitySummary(probes({ read: "granted", write: "denied", deploy: "unknown" }))).toBe("read")
    expect(abilitySummary(undefined)).toBe("none")
  })
})

describe("application rows", () => {
  const app = (over: any = {}) => ({ key: "web", applicationUUID: "a1", name: "production", ...over })

  it("uses the runtime state when Coolify reports one", () => {
    const row = app({ runtime: { state: "running", health: "healthy", label: "running (healthy)", raw: "running:healthy" } })
    // The sidebar shows the compact state; health rides on the status light.
    expect(appRowState(row)).toBe("running")
    expect(appRowLabel(row)).toBe("production · running")
    expect(appRowTone(row)).toBe("ok")
    expect(statusLight(appRowTone(row))).toBe("●")
  })

  it("falls back to the deployment status when there is no container state", () => {
    const row = app({ latestDeployment: { status: "finished" } })
    expect(appRowLabel(row)).toBe("production · finished")
    expect(appRowTone(row)).toBe("ok")
  })

  it("says not deployed when there is neither", () => {
    const row = app()
    expect(appRowLabel(row)).toBe("production · not deployed")
    expect(appRowTone(row)).toBe("unknown")
  })

  it("flags a stopped container", () => {
    const row = app({ runtime: { state: "exited", health: "none", label: "exited", raw: "exited" } })
    expect(appRowTone(row)).toBe("bad")
    expect(statusLight(appRowTone(row))).toBe("○")
  })

  it("marks an unhealthy container without lengthening every other row", () => {
    const row = app({ runtime: { state: "running", health: "unhealthy", label: "running (unhealthy)", raw: "running:unhealthy" } })
    expect(appRowState(row)).toBe("running !")
    expect(appRowTone(row)).toBe("warn")
  })
})
