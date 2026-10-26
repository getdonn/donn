---
"@getdonn/cli": minor
---

`donn ui` opens the donn app in your browser, served by a loopback bridge in the daemon: it listens on 127.0.0.1 only, signs the page in with a one-time code that expires in 60 s and a UI token, checks every request's Host and Origin, runs only an allowlist of commands, streams jobs and events, and can open a file in your editor. `--no-open` prints the URL instead and `--port` picks the port. Turn the bridge off with `daemon.ui: false` in config.yaml.
