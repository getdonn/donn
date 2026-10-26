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

## Agents

A project persona can declare agents that run on it (eve is the first framework):

```sh
donn agent create pr-bot --template eve:blank --target local
donn agent run pr-bot            # local: eve build + start, through the daemon when it runs
donn agent build pr-bot          # self-host: eve build, deploy/donn/Dockerfile and env.json
donn agent deploy pr-bot         # vercel: link, env push after confirming, eve deploy
```

Also `add` (an eve registry item, such as `channel/github`, with eve's questions), `templates`
(the templates `create` takes), `deploy --dry-run` (what a deploy would set, nothing pushed),
`list`, `sync`, `stop`, `logs`, `env` and `exec` (meant for entrypoints and scripts: no
stdin or terminal). Run self-host images with `docker run --init`. The
[README's Agents section](https://github.com/getdonn/donn#agents) covers targets, the two images
to ship, `env.json` and secrets.

## The web UI

```sh
donn ui              # open the app in your browser (starts the daemon unless daemon.autoStart is false)
donn ui --no-open    # print the URL, with its one-time code, instead
donn ui --port 7777  # listen on a fixed port (127.0.0.1 only)
```

The app ships inside this package. See the
[README's web UI section](https://github.com/getdonn/donn#the-web-ui) for the screens and the
bridge's security model.

## Who uses it directly

End users. The other `@getdonn/*` packages are libraries behind this command.

## Docs

- [Repository and README](https://github.com/getdonn/donn#readme)
- [Documentation](https://getdonn.dev)
- [Planning docs](https://github.com/getdonn/donn/tree/main/docs/planning)
