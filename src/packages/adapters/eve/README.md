# @getdonn/adapter-eve

The eve adapter. It compiles a persona into the files of an eve agent: instructions, skills and MCP connections written into the agent's own slots under `donn` names, plus the model configuration that routes the agent through an org's gateway.

## Who uses it directly

Mostly the donn CLI. The adapter is a pure function from a resolved persona to files and a report; it implements the `AgentAdapter` contract from `@getdonn/adapter-sdk`.

## More

See the [donn repository](https://github.com/getdonn/donn#readme).
