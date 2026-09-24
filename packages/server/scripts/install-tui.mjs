#!/usr/bin/env node
/**
 * Install the Coolify TUI half as a local OpenCode plugin.
 *
 * An npm-packaged TUI plugin is loaded from `node_modules`, where OpenCode
 * skips its OpenTUI/Solid transform; the plugin then builds elements against
 * its own renderer context and either crashes or never repaints (opencode
 * issue #33884). Local plugins live outside `node_modules`, so the transform
 * runs and the sidebar bridges to the host renderer.
 *
 * This copies the TUI source (beside this package) into
 * `~/.config/opencode/plugins/coolify-client/` and rewrites the shared
 * package imports to relative paths, so the installed copy is self-contained.
 */
import { cp, mkdir, rm, symlink, writeFile, access, readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const configDir = join(homedir(), ".config", "opencode")
const target = join(configDir, "plugins", "coolify-client")

const clientSrc = join(packageRoot, "client")
const sharedSrc = join(packageRoot, "shared")

await rm(target, { recursive: true, force: true })
await mkdir(join(target, "client"), { recursive: true })
await mkdir(join(target, "shared"), { recursive: true })
await cp(clientSrc, join(target, "client"), { recursive: true })
await cp(sharedSrc, join(target, "shared"), { recursive: true })

// The copied client imports `@skyvence/coolify-oc-shared/*`; point those at the
// sibling `shared/` copy instead of a package that is not installed.
const SHARED_SPECIFIER = "@skyvence/coolify-oc-shared/"
for (const entry of await readdir(join(target, "client"))) {
  if (!/\.tsx?$/.test(entry)) continue
  const path = join(target, "client", entry)
  const text = await readFile(path, "utf8")
  await writeFile(path, text.split(`"${SHARED_SPECIFIER}`).join('"../shared/'))
}

// Only the TUI half. A distinct id keeps the packaged TUI half (disabled by id
// in config) from disabling this local copy too.
await writeFile(
  join(target, "tui.ts"),
  'import local from "./client/tui"\n\nexport default { ...local, id: "opencode.coolify.local.tui" }\n',
)
await writeFile(
  join(target, "package.json"),
  JSON.stringify(
    { name: "coolify-client-local", private: true, type: "module", exports: { "./tui": "./tui.ts" } },
    null,
    2,
  ) + "\n",
)

// Runtime deps resolve through the config directory's node_modules.
const targetModules = join(target, "node_modules")
await rm(targetModules, { recursive: true, force: true })
try {
  await access(join(configDir, "node_modules"))
  await symlink(join(configDir, "node_modules"), targetModules, "dir")
} catch {
  // OpenCode installs the config node_modules from the config package.json.
}

console.log(`Coolify TUI installed at ${target}`)
console.log("Restart OpenCode, then the Coolify sidebar loads as a local plugin.")
