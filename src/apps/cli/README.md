# @getdonn/cli

donn is a persona compiler and control plane for AI coding harnesses. A persona is a declarative,
composable bundle (instructions, skills, MCP servers, permissions, hooks, knowledge pointers, secret
references) that inherits through org, area, team, project and user layers and compiles to each
harness's native config. This package provides the `donn` command.

## Install

```sh
npm i -g @getdonn/cli
```

Requires Node 24 or later.

## Quick start

```sh
donn init --personas ~/personas   # set up your personas folder (flags only)
donn init --extends <persona>     # set up a project that extends a persona
donn claude                       # launch Claude Code with the active persona
donn mod install                  # add the Claude Code mod (status band and /persona)
```

Run `donn --help` for every command; each supports `--json`.

## Who uses it directly

End users. The other `@getdonn/*` packages are libraries behind this command.

## Docs

- [Repository and README](https://github.com/getdonn/donn#readme)
- [Documentation](https://getdonn.dev)
- [Planning docs](https://github.com/getdonn/donn/tree/main/docs/planning)
