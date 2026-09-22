# Naming

A name should identify exactly one action. That matters more here than in most
projects, because half of these names are read by a model rather than a person:
a tool name is what the model calls, a skill name is what it loads, and a
sidebar label is what you click. When the same word means two of those things,
the model guesses.

`test/naming.test.ts` enforces the rules below. This file explains them.

## Namespaces

| Surface | Convention | Example | Who reads it |
| --- | --- | --- | --- |
| Model tools | `coolify_` + `snake_case` | `coolify_configure_project` | the model |
| Permission tiers | `coolify.` + one word | `coolify.destructive` | you, in config |
| Skills | `coolify-` + `kebab-case` | `coolify-link` | the model, and any client with skills |
| Slash command | `coolify`, aspects as arguments | `/coolify token` | you |
| RPC methods | `camelCase` | `writeProjectJson` | the two plugin halves |
| RPC events | `subject.pastTense` | `project.changed` | the two plugin halves |
| Plugin ids | `opencode.` + dotted | `opencode.coolify.tui` | the runtime |
| `coolify.json` keys | `camelCase` | `applicationUUID` | you, and Coolify |
| Options | `camelCase` | `refreshSeconds` | you, in config |
| Sidebar labels | one lowercase word | `link` | you |

The prefix belongs to the namespace, not the name: a tool is declared `link` and
becomes `coolify_link`. Declaring `coolify_link` renders `coolify_coolify_link`.

## Rules

1. **One name, one action.** If two things answer to the same word, one of them
   is wrong. This is the rule the others exist to serve.
2. **Reuse the domain's word.** `link` is what the code already says —
   `coolify_link`, `linked`, `link.changed`, `unlink`. Inventing `map` for the
   same idea is how the sidebar and the codebase came to disagree.
3. **Name for the outcome, not the mechanism.** `link`, not `write-config-file`.
4. **Casing never varies within a namespace.** Not `coolify_link` for a skill,
   not `coolify-link` for a tool.
5. **A deliberate collision is declared.** Sharing a stem across namespaces is
   allowed when the audiences differ and the meaning is the same — but it goes in
   `SHARED_STEMS` with a reason, so it is a decision rather than an accident.

Rule 5 is an escape hatch, and the test fails if an entry in it stops being
shared. An allowlist entry that has outlived its collision is a comment
pretending to be a rule.

## Shared stems

Two stems are currently shared between a tool and a skill:

| Stem | Why |
| --- | --- |
| `link` | `coolify_link` pins one application UUID locally; the `coolify-link` skill discovers what exists and records the mapping in `coolify.json`. Same outcome, different means. |
| `deploy` | `coolify_deploy` triggers one deployment; the `coolify-deploy` skill orchestrates configuration and deployment together. |

`link` is the one worth watching. A model asked to "link this project" could
reasonably call `coolify_link`, which needs a UUID it may not have — so the
tool's description ends by naming the skill as the alternative. If that ever
proves insufficient, the fix is to rename the tool to `coolify_pin`, which
follows rule 3 less well but removes the collision.

## Synonyms

The aspect table is canonical. The parser also accepts a few synonyms
(`url`, `endpoint`, `key`, `status`, `capabilities`, `applications`, `all`)
because forgiving input handling is worth more than a lecture. Synonyms are not
names: nothing else may use them, and none of them may become canonical.

`map` is deliberately *not* accepted, even though it was the previous name. A
retired word that still works is not retired.

## Why this exists

`map` was simultaneously a sidebar label, a slash command and a skill, and two
of the three meant different things: the label and the skill ran the model, the
command did not. Nothing was broken, which is exactly why it lasted — the cost
was a model and a user who each had to learn which "map" they were looking at.

Renaming to `link` fixed that instance. The tests are what stop the next one.
