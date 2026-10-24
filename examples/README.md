# Examples

A demo project and the personas it inherits from, to try donn without writing your own:

| Path                          | Layer   | What it adds                                                                             |
| ----------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `personas/org/acme.yaml`      | org     | conduct and security instructions, a knowledge pointer, deny and ask rules (deny locked) |
| `personas/team/web.yaml`      | team    | extends `org/acme`; the web stack, a `web-review` skill, allow rules                     |
| `demo-app/.donn/persona.yaml` | project | extends `team/web`; the app overview and a codeword for testing                          |

## Try it

Point donn at these personas. Either in your own config:

```sh
# ~/.donn/config.yaml
personas: /path/to/persona-ai/examples/personas
```

or, to leave your setup alone, with a throwaway home:

```sh
export DONN_HOME="$(mktemp -d)"
echo "personas: $PWD/examples/personas" > "$DONN_HOME/config.yaml"
```

Then, from `examples/demo-app`:

```sh
donn resolve            # org/acme → team/web → project/persona
donn resolve --explain  # where each value came from
donn capabilities       # what each harness can carry
donn claude             # Claude Code with the project persona
```

With the daemon running (`donn daemon start`), edit `ZZ-DEMO-1` in
`demo-app/.donn/persona.yaml` while that Claude Code session is open, then ask it for the
persona codeword: the next turn answers with the new one. `donn status` shows the session
refreshed.

A CLI test (`src/apps/cli/src/examples.test.ts`) resolves and compiles these personas, so they
stay current with the spec.
