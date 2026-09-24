/**
 * Rewrite host-owned runtime imports in the built bundle.
 *
 * A packaged TUI plugin gets its own `@opentui/solid` and `solid-js` copies
 * from `node_modules`. Each copy owns its own `RendererContext`, so the
 * plugin's elements are built against a renderer the host never provided:
 * rendering throws "No renderer found" (or the sidebar silently never
 * updates).
 *
 * OpenTUI's runtime plugin registers the host's copies under virtual
 * `opentui:runtime-module:*` ids. Importing those ids instead gives the
 * plugin the host's instances, so there is exactly one renderer context.
 *
 * The ids are the same derivation the runtime plugin uses, so they cannot
 * drift.
 */
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runtimeModuleIdForSpecifier } from "@opentui/core/runtime-plugin"

const dist = fileURLToPath(new URL("../dist/", import.meta.url))
const specifiers = [
  "@opentui/core",
  "@opentui/solid",
  "@opentui/solid/jsx-runtime",
  "@opentui/solid/jsx-dev-runtime",
  "solid-js",
]

const rewrites = specifiers.map((specifier) => [`"${specifier}"`, `"${runtimeModuleIdForSpecifier(specifier)}"`])

for (const entry of await readdir(dist)) {
  if (!entry.endsWith(".js")) continue
  const path = join(dist, entry)
  let text = await readFile(path, "utf8")
  for (const [from, to] of rewrites) text = text.split(from).join(to)
  await writeFile(path, text)
}
