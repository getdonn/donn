---
"@getdonn/cli": patch
---

`donn agent build --json` also prints what it wrote (`contents.dockerfile`, `contents.envFile`), so `donn ui` can show the Dockerfile and `env.json` without reading files: `env.json` names each secret by its ref, never its value
