# @getdonn/resolver

Resolves a persona's `extends` DAG across the org, area, team, project and user layers into the harness-neutral resolved IR, applying the per-field merge semantics and locks. It also provides `explain` and `diff` over resolved personas.

## Who uses it directly

The control plane, which resolves personas server-side. Otherwise it is internal to the donn CLI.

## More

See the [donn repository](https://github.com/getdonn/donn#readme).
