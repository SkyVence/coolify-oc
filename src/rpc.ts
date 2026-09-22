import { Rpc } from "@opencode/plugin/rpc"

/**
 * RPC contract shared by the server plugin and the TUI plugin.
 *
 * The server half implements it and the TUI half calls it through
 * `context.client.rpc(Coolify)`, so the terminal never handles the API token or
 * talks to Coolify directly.
 *
 * Schemas are plain JSON Schema, which `Rpc.define` accepts without extra
 * dependencies. That means method payloads are `unknown` to TypeScript, so the
 * payload interfaces below are the hand-written contract both halves agree on.
 */

/**
 * A JSON Schema object node.
 *
 * Declared as a type alias (not an interface) so it keeps an implicit index
 * signature and structurally satisfies `JsonSchema.JsonSchema`. The literal
 * `type: "object"` is also what `Rpc.EventValueSchema` requires.
 */
type ObjectSchema = {
  readonly type: "object"
  readonly properties: Record<string, unknown>
  readonly required: readonly string[]
  readonly additionalProperties: boolean
}

const object = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): ObjectSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

const string = { type: "string" } as const
const boolean = { type: "boolean" } as const
const integer = { type: "integer" } as const
const unknownObject = { type: "object" } as const
const probe = object({ status: string, detail: string }, ["status", "detail"])

/**
 * One definition of the capabilities payload, reused so the nested copy inside
 * `status` cannot drift. Optional fields are simply omitted from `required`;
 * `additionalProperties: false` still rejects keys the payload never sends.
 */
const capabilitiesSchema = object({
  connected: boolean,
  endpoint: string,
  endpointConfigured: boolean,
  team: object({ id: string, name: string }),
  probes: object({
    read: probe,
    "read:sensitive": probe,
    write: probe,
    deploy: probe,
  }),
  likelyRoot: boolean,
  checkedAt: integer,
  notes: { type: "array", items: string },
  message: string,
})

export const Coolify = Rpc.define({
  id: "coolify",
  methods: {
    capabilities: {
      input: object({}),
      output: capabilitiesSchema,
    },
    refreshCapabilities: {
      input: object({}),
      output: capabilitiesSchema,
    },
    setEndpoint: {
      input: object({ endpoint: string }, ["endpoint"]),
      output: object({ ok: boolean, endpoint: string, message: string }),
    },
    resolve: {
      input: object({ autoLink: boolean, directory: string }),
      output: object({
        source: string,
        ambiguous: boolean,
        best: unknownObject,
        candidates: { type: "array", items: unknownObject },
        link: unknownObject,
        config: unknownObject,
        notes: { type: "array", items: string },
        message: string,
      }),
    },
    link: {
      input: object(
        {
          applicationUUID: string,
          projectUUID: string,
          environmentName: string,
          serverUUID: string,
          name: string,
          gitRepository: string,
        },
        ["applicationUUID"],
      ),
      output: object({ link: unknownObject, message: string }),
    },
    unlink: {
      input: object({}),
      output: object({ ok: boolean }),
    },
    status: {
      input: object({ applicationUUID: string }),
      output: object({
        connected: boolean,
        endpoint: string,
        endpointConfigured: boolean,
        linked: boolean,
        resolution: unknownObject,
        application: unknownObject,
        latestDeployment: unknownObject,
        capabilities: capabilitiesSchema,
        message: string,
      }),
    },
    applications: {
      input: object({ scope: string, directory: string }),
      output: object({
        connected: boolean,
        endpoint: string,
        endpointConfigured: boolean,
        projectUUID: string,
        environmentName: string,
        configFile: string,
        scope: string,
        apps: { type: "array", items: unknownObject },
        capabilities: capabilitiesSchema,
        message: string,
      }),
    },
    configureProject: {
      input: object({
        directory: string,
        projectUUID: string,
        environmentName: string,
        serverUUID: string,
        applicationUUID: string,
        applications: unknownObject,
        databases: unknownObject,
      }),
      output: object({
        ok: boolean,
        file: string,
        applications: integer,
        databases: integer,
        message: string,
      }),
    },
    logs: {
      input: object({ applicationUUID: string, lines: integer }),
      output: object({ logs: string, message: string }),
    },
    deploy: {
      input: object({
        action: string,
        applicationUUID: string,
        databaseUUID: string,
        deploymentUUID: string,
        commit: string,
        force: boolean,
        wait: boolean,
        pr: integer,
      }),
      output: object({
        tickets: { type: "array", items: unknownObject },
        wait: unknownObject,
        message: string,
      }),
    },
    cancelDeployment: {
      input: object({ deploymentUUID: string }, ["deploymentUUID"]),
      output: object({ message: string, status: string }),
    },
  },
  events: {
    "deploy.progress": {
      schema: object(
        { applicationUUID: string, deploymentUUID: string, status: string, message: string },
        ["applicationUUID", "deploymentUUID", "status", "message"],
      ),
    },
    "link.changed": {
      schema: object({ projectID: string, applicationUUID: string, source: string }, [
        "projectID",
        "applicationUUID",
        "source",
      ]),
    },
    "capabilities.changed": {
      schema: object({ endpoint: string, read: string, write: string, deploy: string }, [
        "endpoint",
        "read",
        "write",
        "deploy",
      ]),
    },
    "project.changed": {
      schema: object({ file: string }, ["file"]),
    },
  },
})

import type { RuntimeHealth, RuntimeState } from "./coolify/runtime"

// ---------------------------------------------------------------------------
// Payload contract shared with the TUI
// ---------------------------------------------------------------------------

export interface ProbePayload {
  readonly status: "granted" | "denied" | "unknown"
  readonly detail: string
}

export interface CapabilitiesPayload {
  readonly connected: boolean
  readonly endpoint?: string
  readonly endpointConfigured?: boolean
  readonly team?: { readonly id?: string; readonly name?: string }
  readonly probes?: Readonly<Record<string, ProbePayload>>
  readonly likelyRoot?: boolean
  readonly checkedAt?: number
  readonly notes?: readonly string[]
  readonly message?: string
}

export interface CandidatePayload {
  readonly applicationUUID: string
  readonly name: string
  readonly gitRepository?: string
  readonly domains?: string
  readonly score?: number
  readonly reasons?: readonly string[]
}

export interface LinkPayload {
  readonly applicationUUID: string
  readonly projectUUID?: string
  readonly environmentName?: string
  readonly serverUUID?: string
  readonly name?: string
  readonly gitRepository?: string
  readonly source?: string
}

export interface ProjectConfigSummaryPayload {
  readonly file?: string
  readonly relativeFile?: string
  readonly projectUUID?: string
  readonly environmentName?: string
  readonly serverUUID?: string
  readonly selected?: {
    readonly key: string
    readonly applicationUUID: string
    readonly path?: string
    readonly reason: string
  }
  readonly applications?: Readonly<Record<string, { readonly applicationUUID: string; readonly path?: string }>>
  readonly databases?: Readonly<Record<string, { readonly databaseUUID?: string; readonly type?: string; readonly name?: string }>>
}

export interface ResolvePayload {
  readonly source: "config" | "pin" | "discovered" | "none"
  readonly ambiguous: boolean
  readonly best?: CandidatePayload
  readonly candidates: readonly CandidatePayload[]
  readonly link?: LinkPayload
  readonly config?: ProjectConfigSummaryPayload
  readonly notes: readonly string[]
  readonly message?: string
}

export interface AppStatusPayload {
  readonly key: string
  readonly applicationUUID: string
  readonly name: string
  readonly path?: string
  readonly domains?: string | null
  readonly runtime?: RuntimePayload
  readonly latestDeployment?: DeploymentPayload
  /** True for the entry that owns the working directory. */
  readonly selected?: boolean
}

export interface ApplicationsPayload {
  readonly connected: boolean
  readonly endpoint?: string
  readonly endpointConfigured?: boolean
  readonly projectUUID?: string
  readonly environmentName?: string
  readonly configFile?: string
  readonly scope?: "mapped" | "project"
  readonly apps?: readonly AppStatusPayload[]
  readonly capabilities?: CapabilitiesPayload
  readonly message?: string
}

export interface DeploymentPayload {
  readonly deployment_uuid?: string
  readonly status?: string
  readonly created_at?: string
  readonly updated_at?: string
  readonly commit?: string
  readonly commit_message?: string
}

export interface RuntimePayload {
  readonly state: RuntimeState
  readonly health: RuntimeHealth
  readonly label: string
  readonly raw: string
}

export interface StatusPayload {
  readonly connected: boolean
  readonly endpoint?: string
  readonly endpointConfigured?: boolean
  readonly linked: boolean
  readonly resolution?: ResolvePayload
  readonly application?: {
    readonly uuid?: string
    readonly name?: string
    readonly fqdn?: string | null
    readonly status?: string
    readonly runtime?: RuntimePayload
  }
  readonly latestDeployment?: DeploymentPayload
  readonly capabilities?: CapabilitiesPayload
  readonly message?: string
}

export interface DeployProgressData {
  readonly applicationUUID: string
  readonly deploymentUUID: string
  readonly status: string
  readonly message: string
}
