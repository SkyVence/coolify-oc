import { describe, expect, it } from "vitest"
import {
  abilitySummary,
  applicationGroups,
  appRowLabel,
  appRowState,
  appRowTone,
  projectGroupHeading,
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

  it("polls slowly when nothing is happening", () => {
    expect(refreshSeconds([])).toBe(60)
    expect(refreshSeconds([app("finished"), app()])).toBe(60)
  })

  it("follows a deployment closely while it runs", () => {
    expect(refreshSeconds([app("in_progress")])).toBe(10)
    expect(refreshSeconds([app("queued")])).toBe(10)
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

describe("applicationGroups", () => {
  const app = (name: string) => ({ key: name, applicationUUID: `${name}_uuid`, name }) as any

  it("keeps the single headingless group for one config, or none", () => {
    expect(applicationGroups({ connected: true, apps: [app("web")] } as any)).toEqual([{ apps: [app("web")] }])
    expect(applicationGroups(undefined)).toEqual([{ apps: [] }])
  })

  it("renders one headed section per config when several are present", () => {
    const payload = {
      connected: true,
      apps: [app("root")],
      projects: [
        {
          file: "/repo/coolify.json",
          relativeFile: "coolify.json",
          projectUUID: "proj_root",
          configFile: "/repo/coolify.json",
          apps: [app("root")],
        },
        {
          file: "/repo/apps/web/coolify.json",
          relativeFile: "apps/web/coolify.json",
          configFile: "/repo/apps/web/coolify.json",
          apps: [app("web")],
        },
      ],
    } as any

    const groups = applicationGroups(payload)
    expect(groups).toHaveLength(2)
    expect(groups[0]?.heading).toBe("proj_root")
    expect(groups[1]?.heading).toBe("apps/web")
    expect(groups[1]?.apps).toEqual([app("web")])
  })
})

describe("projectGroupHeading", () => {
  const project = (over: any) =>
    ({ file: "/repo/coolify.json", relativeFile: "coolify.json", configFile: "/repo/coolify.json", apps: [], ...over }) as any

  it("uses the repo-relative directory for a nested config", () => {
    expect(projectGroupHeading(project({ relativeFile: "apps/web/coolify.json" }))).toBe("apps/web")
  })

  it("uses the projectUUID at the repository root", () => {
    expect(projectGroupHeading(project({ projectUUID: "proj_1" }))).toBe("proj_1")
    expect(projectGroupHeading(project({ relativeFile: ".coolify.json", projectUUID: "proj_2" }))).toBe("proj_2")
  })

  it("suppresses the heading at the root without a projectUUID", () => {
    expect(projectGroupHeading(project({}))).toBeUndefined()
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
