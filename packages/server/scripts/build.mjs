/**
 * Build the server plugin and stage the files the TUI installer copies.
 *
 * The server bundle is compiled with `@opencode/*` left external — those are
 * host-owned. The shared workspace package is bundled in, so the published
 * package has no private workspace dependency.
 *
 * The client is not bundled: the TUI half is installed as source (see
 * `install-tui.mjs`), so `client/` and `shared/` are copied into the package
 * for the installer to read.
 */
import { cp, mkdir, rm } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const scripts = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(scripts, "..")
const repoRoot = join(packageRoot, "..", "..")

const externals = [
  "@opencode/plugin",
  "@opencode/plugin/rpc",
  "@opencode/plugin/promise/tool",
  "@opencode/schema/schema",
  "@opencode/schema/skill",
]

await rm(join(packageRoot, "dist"), { recursive: true, force: true })
const build = spawnSync(
  "bun",
  [
    "build",
    join(packageRoot, "src", "index.ts"),
    "--outdir",
    join(packageRoot, "dist"),
    "--target",
    "bun",
    "--format",
    "esm",
    "--production",
    ...externals.flatMap((specifier) => ["--external", specifier]),
  ],
  { stdio: "inherit" },
)
if (build.status !== 0) process.exit(build.status ?? 1)

for (const [from, to] of [
  [join(repoRoot, "packages", "client", "src"), join(packageRoot, "client")],
  [join(repoRoot, "packages", "shared", "src"), join(packageRoot, "shared")],
]) {
  await rm(to, { recursive: true, force: true })
  await cp(from, to, { recursive: true })
}

for (const name of ["README.md", "NAMING.md", "LICENSE"]) {
  await rm(join(packageRoot, name), { recursive: true, force: true })
  await cp(join(repoRoot, name), join(packageRoot, name))
}

console.log("server built; client and shared staged for the TUI installer")
