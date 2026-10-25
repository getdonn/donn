#!/bin/zsh
# usage: name-rule.sh <dir> <ext> name...  -- tries each connection/skill name in isolation via `eve info --json`
cd "$(dirname $0)/proj"; export PATH=$PWD/node_modules/.bin:$PATH
for n in "$@"; do
  f=agent/connections/$n.ts
  printf 'import { defineMcpClientConnection } from "eve/connections";\nexport default defineMcpClientConnection({ url: "http://127.0.0.1:4020/sse", description: "a" });\n' > $f
  r=$(eve info --json 2>&1 | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status'], d['diagnostics']['errors'], d['diagnostics']['warnings'])" 2>&1)
  echo "len=${#n} $n => $r"
  rm $f
done
