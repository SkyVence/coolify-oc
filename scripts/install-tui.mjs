#!/usr/bin/env node
/**
 * Install the Coolify TUI half as a local OpenCode plugin.
 *
 * An npm-packaged TUI plugin is loaded from `node_modules`, where OpenCode
 * skips its Solid JSX transform; the plugin then builds elements against its
 * own `@opentui/solid` renderer context and either crashes or never repaints
 * (opencode issue #33884). Local plugins live outside `node_modules`, so the
 * transform runs and the JSX is bridged to the host renderer.
 *
 * This copies the plugin source out of the package into
 * `~/.config/opencode/plugins/coolify-client/`, where OpenCode auto-loads it,
 * and writes a `package.json` so the runtime deps resolve.
 */
import { cp, mkdir, rm, symlink, writeFile, access } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "")
const configDir = join(homedir(), ".config", "opencode")
const target = join(configDir, "plugins", "coolify-client")

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(join(packageRoot, "src"), join(target, "src"), { recursive: true })

// Only the TUI half. The server half stays on npm; exposing "." here would
// register the tools and RPC a second time. A distinct id keeps the packaged
// TUI half (disabled by id in config) from disabling this local copy too.
await writeFile(
  join(target, "tui.ts"),
  'import local from "./src/tui"\n\nexport default { ...local, id: "opencode.coolify.local.tui" }\n',
)
await writeFile(join(target, "rpc.ts"), 'export * from "./src/rpc"\n')
await writeFile(
  join(target, "package.json"),
  JSON.stringify(
    {
      name: "coolify-client-local",
      private: true,
      type: "module",
      exports: { "./tui": "./tui.ts", "./rpc": "./rpc.ts" },
    },
    null,
    2,
  ) + "\n",
)

// The runtime deps resolve through the config directory's node_modules.
const configModules = join(configDir, "node_modules")
const targetModules = join(target, "node_modules")
await rm(targetModules, { recursive: true, force: true })
try {
  await access(configModules)
  await symlink(configModules, targetModules, "dir")
} catch {
  // No config node_modules yet; OpenCode installs it from the config package.json.
}

console.log(`Coolify TUI installed at ${target}`)
console.log("Restart OpenCode, then the Coolify sidebar loads as a local plugin.")
