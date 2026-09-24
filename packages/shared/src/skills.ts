/**
 * The plugin's prompts, as skills rather than as strings the TUI pastes in.
 *
 * A registered skill travels with the plugin but is consumed like any other
 * skill: the model sees it in its skill guidance, the `skill` tool can load it,
 * and a prompt can carry `skills: [{ id }]` — the runtime expands the content
 * into the message. That means a client which exposes skills but not plugin
 * tools still gets the same behaviour, which a hardcoded prompt string could
 * never offer.
 *
 * `id` is the name used to invoke a skill, so it is part of the public surface:
 * renaming one breaks any client holding the old name.
 */
export interface CoolifySkill {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly content: string
}

export const LINK_SKILL: CoolifySkill = {
  id: "coolify-link",
  name: "Coolify link",
  description:
    "Link this repository to its existing Coolify applications and record the result in coolify.json, using the coolify tools. Use when the project is not linked to Coolify, when coolify.json is missing or wrong, or for a monorepo where several applications need linking.",
  content: `Inspect this repository and link it to its existing Coolify applications, recording the result in \`coolify.json\` with the \`coolify\` tools.

Ask before writing anything, and never invent a UUID.

1. Call \`coolify_resolve\` to see what is already mapped, then \`coolify_list_resources\` to see the
   available applications, projects, servers, and environments.
2. Work out whether this is a monorepo by looking for multiple deployable packages — workspace
   manifests (pnpm/npm/yarn workspaces, go.work, Cargo workspace), several Dockerfiles, or several
   compose files — and note the repo-relative directory each one owns.
3. Call \`coolify_databases\` and record the databases this project already has.
4. Propose the whole \`coolify.json\` and show it to me before writing.
5. Ask me, with the \`question\` tool, about every mapping you are unsure of. Offer the candidates
   you found rather than asking me to supply raw UUIDs.
6. Write the agreed file with \`coolify_configure_project\`. Do not create applications or databases
   in this step; only record what already exists. Tell me to commit the file afterwards.`,
}

export const DEPLOY_SKILL: CoolifySkill = {
  id: "coolify-deploy",
  name: "Coolify deploy",
  description:
    "Set up and deploy this project on Coolify, using the coolify tools. Use when the user asks to deploy, redeploy, or configure a project's Coolify application, domain, port, or build pack.",
  content: `Set up and deploy this project on Coolify, using the \`coolify\` tools.

Ask me whenever something is ambiguous — do not guess, and do not provision anything I have not confirmed.

1. Call \`coolify_resolve\` and read its \`config\` block.
   - If a \`coolify.json\` entry covers this directory, use it.
   - In a monorepo where several applications are listed but none owns this directory, do NOT pick
     one: show me the keys and their paths and ask which applies, using the \`question\` tool.
   - If nothing is linked, call \`coolify_list_resources\`, show me the candidates, and ask. Then
     pin the answer with \`coolify_link\`.
   - If this project is not on Coolify at all, offer to create it with \`coolify_plan_application\`
     then \`coolify_create_application\`, and confirm the plan with me first.
2. Call \`coolify_application\` with action "settings" to read what is configurable, and
   "deployments" for the history. Call \`coolify_application\` action "envs" for variable names.
3. Databases: call \`coolify_databases\`, then compare against the databases in \`coolify.json\` and
   against what the repository actually needs (look at .env files, compose files, and config).
   - If something required is missing, tell me what you propose — engine, name, internal or
     public, and which project and server — and ask before calling \`coolify_create_database\`.
   - Skip this step if the project uses no database.
4. Ask me, in one batch of \`question\` calls, about anything that should change before deploying:
   at minimum the public domain, the exposed port, and the build pack when it is not obvious.
   Infer sensible defaults from the repository so I only have to correct you.
5. Apply what I confirm with \`coolify_application_update\`. In a monorepo, also record the mapping
   with \`coolify_configure_project\` so the next run resolves without asking. Show me the file
   content before writing it.
6. Call \`coolify_deploy\` and report the final status. Deploy any database you created too.`,
}

export const COOLIFY_SKILLS: readonly CoolifySkill[] = [LINK_SKILL, DEPLOY_SKILL]

/**
 * Where a registered skill claims to live. Nothing is read from here — the
 * runtime renders the registered `content`, and only consults the directory
 * when the file is literally named `SKILL.md` (to list bundled resources).
 * The path is deliberately not `SKILL.md` so no directory scan happens, and it
 * is absolute because the schema brands it as such.
 */
export function skillPath(directory: string, id: string): string {
  const base = directory.replace(/\/+$/, "")
  return `${base}/.opencode/skills/${id}.md`
}
