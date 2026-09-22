# Names

The words this plugin reuses, and what each one means.

## The words

| Word | Means |
| --- | --- |
| instance | your Coolify server |
| token | the API token for that instance |
| access | what the token is allowed to do |
| link | point this project at an app that already exists on Coolify, and record it in `coolify.json` |
| deploy | build and start it |
| app | a Coolify application |
| database | a Coolify database |
| project | a Coolify project — groups applications |
| environment | a Coolify environment inside a project, like `production` |
| server | the machine Coolify deploys to |

## Where each name lives

| Surface | Looks like | Example |
| --- | --- | --- |
| tools | `coolify_` then snake_case | `coolify_link` |
| skills | `coolify-` then kebab-case | `coolify-link` |
| the command | `/coolify` then an aspect | `/coolify link` |
| permissions | `coolify.` then a tier | `coolify.write` |
| `coolify.json` keys | camelCase | `applicationUUID` |
| options | camelCase | `refreshSeconds` |
| sidebar | one word | `link` |

The prefix belongs to the surface, not to the name. A tool is declared `link` and
becomes `coolify_link`.

## Two words that are both a tool and a skill

| Word | As a tool | As a skill |
| --- | --- | --- |
| link | `coolify_link` pins **one** app to this project. It needs a UUID, and it does not touch `coolify.json`. | `coolify-link` finds out what exists and writes `coolify.json`. |
| deploy | `coolify_deploy` starts one deployment. | `coolify-deploy` sets things up and deploys. |

If you ever ask for "link this project" and the model reaches for the tool
instead of the skill, that is why. The tool's description points at the skill.

## Aspects

`/coolify` takes one word. These are the words:

`instance`, `token`, `access`, `apps`, `link`, `link model`, `deploy`

Anything else gets a warning listing them. `map` is not one of them — it was the
old name for `link`.
