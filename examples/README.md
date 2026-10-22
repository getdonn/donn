# Examples

A demo project and the personas it inherits from, to try zzpersona without writing your own:

| Path                               | Layer   | What it adds                                                                             |
| ---------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `personas/org/acme.yaml`           | org     | conduct and security instructions, a knowledge pointer, deny and ask rules (deny locked) |
| `personas/team/web.yaml`           | team    | extends `org/acme`; the web stack, a `web-review` skill, allow rules                     |
| `demo-app/.zzpersona/persona.yaml` | project | extends `team/web`; the app overview and a codeword for testing                          |

## Try it

Point zzpersona at these personas. Either in your own config:

```sh
# ~/.zzpersona/config.yaml
personas: /path/to/persona-ai/examples/personas
```

or, to leave your setup alone, with a throwaway home:

```sh
export ZZPERSONA_HOME="$(mktemp -d)"
echo "personas: $PWD/examples/personas" > "$ZZPERSONA_HOME/config.yaml"
```

Then, from `examples/demo-app`:

```sh
zzpersona resolve            # org/acme → team/web → project/persona
zzpersona resolve --explain  # where each value came from
zzpersona capabilities       # what each harness can carry
zzpersona claude             # Claude Code with the project persona
```

With the daemon running (`zzpersona daemon start`), edit `ZZ-DEMO-1` in
`demo-app/.zzpersona/persona.yaml` while that Claude Code session is open, then ask it for the
persona codeword: the next turn answers with the new one. `zzpersona status` shows the session
refreshed.

A CLI test (`src/apps/cli/src/examples.test.ts`) resolves and compiles these personas, so they
stay current with the spec.
