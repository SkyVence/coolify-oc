import local from "../../../src/index"

/**
 * The working tree under a distinct plugin id.
 *
 * The published package registers as `opencode.coolify`. This checkout cannot
 * reuse that id: OpenCode keys the `-id` disables on the plugin id, so disabling
 * the package here would disable the local copy too. A separate id lets
 * `opencode.jsonc` turn off `opencode.coolify` and keep this one.
 */
export default { ...local, id: "opencode.coolify.local" }
