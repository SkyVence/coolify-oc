import { readFile } from "node:fs/promises"
import { isAbsolute, resolve as resolvePath } from "node:path"
import { listApplicationDeployments } from "../coolify/deploy"
import {
  createEnv,
  deleteEnv,
  getApplicationLogs,
  listEnvs,
  listRollbackImages,
  listStorages,
  updateApplication,
  updateEnv,
} from "../coolify/resources"
import { normalizeDeploymentStatus, parseApplicationStatus } from "@skyvence/coolify-oc-shared/coolify/runtime"
import type { CoolifyDeployment, CoolifyEnvVariable } from "../coolify/types"
import { APPLICATION_SETTING_FIELDS, SETTING_FIELD_SET } from "./settings-fields"
import {
  MISSING_CREDENTIAL,
  WITH_ENDPOINT,
  requireString,
  resolveTarget,
  type ToolDeps,
  type ToolResult,
  type ToolSpec,
} from "./shared"

const ACTIONS = ["settings", "envs", "logs", "deployments", "rollback_images", "storages"] as const
const LOG_TAIL_LIMIT = 4_000

/**
 * Read everything the model is allowed to know about one application, and that
 * it can also change. Without this, `coolify_update_settings` could write fields
 * no tool could read back.
 */
export function applicationTool(deps: ToolDeps): ToolSpec {
  return {
    name: "application",
    tier: "read",
    description: `Inspect the linked Coolify application. Actions:
- settings: the deployment settings you are allowed to change, plus runtime state and domains.
- envs: environment variable names and flags only — values are never returned here.
- logs: recent runtime logs (may be empty if the token lacks read:sensitive).
- deployments: recent deployment history, newest first.
- rollback_images: images available to roll back to.
- storages: persistent volumes and file mounts.`,
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...ACTIONS] },
        applicationUUID: { type: "string", description: "Override the linked application for this call." },
        lines: { type: "integer", description: "logs: how many lines to fetch (default 100)." },
        limit: { type: "integer", description: "deployments: how many to list (default 10)." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      const action = input?.action
      if (!ACTIONS.includes(action)) {
        return { content: `Unknown action \`${action}\`. Choose one of: ${ACTIONS.join(", ")}.` }
      }

      const target = await resolveTarget(deps, input?.applicationUUID, context.signal)
      if (!target) {
        return {
          content:
            "No application is linked to this project. Call `coolify_resolve`, `coolify_link`, or record it in `coolify.json`.",
        }
      }

      if (action === "settings") {
        const application = await deps.getClient()!.request<Record<string, unknown>>({
          method: "GET",
          path: `/applications/${target}`,
          requires: "read",
          signal: context.signal,
        })
        const runtime = parseApplicationStatus(
          typeof application.status === "string" ? application.status : undefined,
        )
        const lines = [
          `Application: ${String(application.name ?? "?")} (${target})`,
          `Runtime: ${runtime.label}`,
          `Domains: ${typeof application.fqdn === "string" && application.fqdn ? application.fqdn : "none"}`,
          "",
          "Settings (changeable with coolify_application_update):",
        ]
        for (const field of APPLICATION_SETTING_FIELDS) {
          const value = application[field]
          if (value === undefined || value === null || value === "") continue
          lines.push(`- ${field}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
        }
        return { content: lines.join("\n"), metadata: { applicationUUID: target, runtime: runtime.label } }
      }

      if (action === "envs") {
        const envs = await listEnvs(client, target, context.signal)
        if (envs.length === 0) return { content: "No environment variables are set." }
        const lines = envs.map((env) => {
          const flags = [
            env.is_preview ? "preview" : "",
            env.is_literal ? "literal" : "",
            env.is_shown_once ? "shown-once" : "",
          ]
            .filter(Boolean)
            .join(" ")
          return `- ${env.key}${flags ? `  [${flags}]` : ""}`
        })
        return {
          content: [
            `Environment variables (${envs.length}). Values are not shown; use coolify_env_value for one value.`,
            ...lines,
          ].join("\n"),
          metadata: { count: envs.length },
        }
      }

      if (action === "logs") {
        const lines = typeof input?.lines === "number" ? input.lines : 100
        const logs = await getApplicationLogs(client, target, { lines, signal: context.signal })
        if (logs.trim() === "") {
          return {
            content: [
              "Coolify returned no logs.",
              "This is usually the token lacking the `read:sensitive` ability — Coolify treats logs as sensitive — rather than the container having produced nothing.",
              "Run `coolify_capabilities` to confirm.",
            ].join("\n"),
            metadata: { applicationUUID: target, empty: true },
          }
        }
        return {
          content: [
            `Runtime logs (last ${lines} lines) — may contain secrets:`,
            "",
            logs.length > LOG_TAIL_LIMIT ? `…truncated…\n${logs.slice(-LOG_TAIL_LIMIT)}` : logs,
          ].join("\n"),
          metadata: { applicationUUID: target, truncated: logs.length > LOG_TAIL_LIMIT },
        }
      }

      if (action === "deployments") {
        const limit = typeof input?.limit === "number" ? input.limit : 10
        const history = (await listApplicationDeployments(client, target, {
          take: limit,
          signal: context.signal,
        })) as readonly CoolifyDeployment[]
        if (!Array.isArray(history) || history.length === 0) {
          return { content: "No deployments recorded for this application." }
        }
        const lines = history.map((deployment) => {
          const status = normalizeDeploymentStatus(deployment.status)
          const commit = deployment.commit ? deployment.commit.slice(0, 7) : "unknown"
          return `- ${deployment.deployment_uuid ?? "?"}  ${status}  commit ${commit}  ${
            deployment.created_at ?? ""
          }`.trim()
        })
        return { content: `Deployments (${history.length}):\n${lines.join("\n")}` }
      }

      if (action === "rollback_images") {
        const images = await listRollbackImages(client, target, context.signal)
        if (images.length === 0) return { content: "No rollback images available." }
        const lines = images.map(
          (image) =>
            `- ${image.commit ? image.commit.slice(0, 7) : "?"}  ${image.image_name ?? ""}  ${image.created_at ?? ""}`.trim(),
        )
        return { content: `Rollback images (${images.length}):\n${lines.join("\n")}` }
      }

      const storages = await listStorages(client, "applications", target, context.signal)
      if (storages.length === 0) return { content: "No storages configured." }
      const lines = storages.map(
        (storage) =>
          `- ${storage.uuid ?? "?"}  ${storage.type ?? "?"}  mount ${storage.mount_path ?? "?"}  ${storage.name ?? ""}`.trim(),
      )
      return { content: `Storages (${storages.length}):\n${lines.join("\n")}` }
    },
  }
}

const UPDATE_ACTIONS = ["settings", "env_set", "env_unset", "env_sync", "storage_create"] as const

/**
 * Change an application. Settings are restricted to the same allow-list the
 * model can read, so a misspelled key fails locally.
 */
export function applicationUpdateTool(deps: ToolDeps): ToolSpec {
  return {
    name: "application_update",
    tier: "write",
    description: `Change the linked Coolify application. Actions:
- settings: patch deployment settings. Only the fields listed by coolify_application action=settings are accepted.
- env_set: create or update one environment variable.
- env_unset: delete one environment variable by key.
- env_sync: read a .env file from the repository and push every entry, without the values entering this conversation.
Changing settings does not redeploy; call coolify_deploy afterwards.`,
    input: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...UPDATE_ACTIONS] },
        applicationUUID: { type: "string" },
        settings: { type: "object", description: "settings: a partial PATCH body.", additionalProperties: true },
        key: { type: "string", description: "env_set / env_unset: the variable name." },
        value: { type: "string", description: "env_set: the variable value." },
        isPreview: { type: "boolean" },
        isLiteral: { type: "boolean" },
        file: { type: "string", description: "env_sync: repo-relative path to a .env file." },
        storage: { type: "object", description: "storage_create body.", additionalProperties: true },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      const action = input?.action
      if (!UPDATE_ACTIONS.includes(action)) {
        return { content: `Unknown action \`${action}\`. Choose one of: ${UPDATE_ACTIONS.join(", ")}.` }
      }

      // Validate the payload before any network call, so a malformed request
      // fails fast and can never reach Coolify.
      let settingKeys: string[] = []
      if (action === "settings") {
        const settings = input?.settings
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
          return { content: "`settings` must be an object of application fields." }
        }
        settingKeys = Object.keys(settings as Record<string, unknown>)
        if (settingKeys.length === 0) return { content: "`settings` is empty; nothing to change." }
        const unknown = settingKeys.filter((key) => !SETTING_FIELD_SET.has(key))
        if (unknown.length > 0) {
          return {
            content: [
              `Unknown setting(s): ${unknown.join(", ")}.`,
              `Call \`coolify_application\` with action "settings" to see the accepted fields.`,
            ].join("\n"),
          }
        }
      }

      const target = await resolveTarget(deps, input?.applicationUUID, context.signal)
      if (!target) return { content: "No application is linked to this project." }

      if (action === "settings") {
        const updated = await updateApplication(
          client,
          target,
          input.settings as Record<string, unknown>,
          context.signal,
        )
        return {
          content: [
            `Updated ${settingKeys.length} setting(s) on ${updated.name ?? target}: ${settingKeys.join(", ")}.`,
            "Run coolify_deploy for the changes to take effect.",
          ].join("\n"),
          metadata: { applicationUUID: target, fields: settingKeys },
        }
      }

      if (action === "env_set") {
        const key = requireString(input, "key")
        if (typeof input?.value !== "string") return { content: "`value` must be a string." }
        const env: { key: string; value: string; is_preview?: boolean; is_literal?: boolean } = {
          key,
          value: input.value,
          ...(input?.isPreview === true ? { is_preview: true } : {}),
          ...(input?.isLiteral === true ? { is_literal: true } : {}),
        }
        const existing = await findEnvKey(client, target, key, context.signal)
        if (existing) await updateEnv(client, target, env, context.signal)
        else await createEnv(client, target, env, context.signal)
        return {
          content: `${existing ? "Updated" : "Created"} environment variable ${key}.`,
          metadata: { applicationUUID: target, key, created: !existing },
        }
      }

      if (action === "env_unset") {
        const key = requireString(input, "key")
        const env = await findEnvKey(client, target, key, context.signal)
        if (!env?.uuid) return { content: `No environment variable named ${key}.` }
        await deleteEnv(client, target, env.uuid, context.signal)
        return { content: `Deleted environment variable ${key}.`, metadata: { applicationUUID: target, key } }
      }

      if (action === "env_sync") {
        const file = requireString(input, "file")
        const path = isAbsolute(file) ? file : resolvePath(deps.directory, file)
        let parsed: { key: string; value: string }[]
        try {
          parsed = parseDotEnv(await readFile(path, "utf8"))
        } catch (cause) {
          return { content: `Could not read ${file}: ${cause instanceof Error ? cause.message : String(cause)}` }
        }
        if (parsed.length === 0) return { content: `${file} contained no KEY=VALUE entries.` }

        // Read the existing names once so we update rather than duplicate.
        const existing = new Set((await listEnvs(client, target, context.signal)).map((env) => env.key))
        let created = 0
        let updated = 0
        for (const entry of parsed) {
          const env = {
            key: entry.key,
            value: entry.value,
            ...(input?.isPreview === true ? { is_preview: true } : {}),
            ...(input?.isLiteral === true ? { is_literal: true } : {}),
          }
          if (existing.has(entry.key)) {
            await updateEnv(client, target, env, context.signal)
            updated += 1
          } else {
            await createEnv(client, target, env, context.signal)
            created += 1
          }
        }
        return {
          // Only names are reported — never the values.
          content: `Synced ${parsed.length} variable(s) from ${file}: ${created} created, ${updated} updated. Values were pushed directly to Coolify and are not shown here.`,
          metadata: { applicationUUID: target, created, updated, file },
        }
      }

      const storage = input?.storage
      if (!storage || typeof storage !== "object" || Array.isArray(storage)) {
        return { content: "`storage` must be an object." }
      }
      const { createStorage } = await import("../coolify/resources")
      const result = await createStorage(
        client,
        "applications",
        target,
        storage as Record<string, unknown>,
        context.signal,
      )
      return {
        content: `Created storage ${result?.uuid ?? "(uuid not returned)"} on ${target}.`,
        metadata: { applicationUUID: target, storageUUID: result?.uuid },
      }
    },
  }
}

/**
 * The only path that returns an environment variable's value.
 *
 * It carries the `coolify.secrets` permission, so a user can deny that single
 * action and remove this tool from the model's view while keeping every other
 * environment operation available.
 */
export function envValueTool(deps: ToolDeps): ToolSpec {
  return {
    name: "env_value",
    tier: "secrets",
    description:
      "Read one environment variable's value from the linked Coolify application. This is the only tool that returns a secret, and it is the one to deny if values must never reach a model. Requires the token to have read:sensitive.",
    input: {
      type: "object",
      properties: {
        key: { type: "string", description: "The variable name." },
        applicationUUID: { type: "string" },
      },
      required: ["key"],
      additionalProperties: false,
    },
    async run(input, context): Promise<ToolResult> {
      const client = deps.getClient()
      if (!client) return { content: WITH_ENDPOINT(deps, MISSING_CREDENTIAL) }

      const key = requireString(input, "key")
      const target = await resolveTarget(deps, input?.applicationUUID, context.signal)
      if (!target) return { content: "No application is linked to this project." }

      const env = await findEnvKey(client, target, key, context.signal)
      if (!env) return { content: `No environment variable named ${key}.` }

      const value = env.value
      if (typeof value !== "string" || value === "") {
        return {
          content: `Coolify returned no value for ${key}. The token most likely lacks the read:sensitive ability, which Coolify requires for environment values. Run coolify_capabilities to confirm.`,
          metadata: { applicationUUID: target, key, redacted: true },
        }
      }
      if (/^\*+$/.test(value)) {
        return {
          content: `Coolify redacted the value of ${key} (the token lacks read:sensitive).`,
          metadata: { applicationUUID: target, key, redacted: true },
        }
      }

      return { content: `${key}=${value}`, metadata: { applicationUUID: target, key } }
    },
  }
}

async function findEnvKey(
  client: NonNullable<ReturnType<ToolDeps["getClient"]>>,
  applicationUUID: string,
  key: string,
  signal?: AbortSignal,
): Promise<CoolifyEnvVariable | undefined> {
  const envs = await listEnvs(client, applicationUUID, signal)
  return envs.find((env) => env.key === key)
}

/** Minimal dotenv parsing: KEY=VALUE, optional `export`, comments and quotes. */
export function parseDotEnv(content: string): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line
    const separator = withoutExport.indexOf("=")
    if (separator <= 0) continue
    const key = withoutExport.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = withoutExport.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    entries.push({ key, value })
  }
  return entries
}
