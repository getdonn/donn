#!/bin/sh
# Spike: what a Codex CLI launch can carry per invocation. Throwaway. Usage: run.sh <scratch> <probe>
# probes: instructions | mcp | mcp-approve | sandbox | hooks | hooks-bypass | skills-key
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$1; probe=$2
repo="$root/repo"
mkdir -p "$repo" && cd "$repo" && [ -d .git ] || git init -q
server="$here/mcp-server.mjs"
mcp="mcp_servers.zz-probe={command=\"node\",args=[\"$server\"],env_vars=[\"ZZ_TOKEN\"]}"
ex() { codex exec --skip-git-repo-check "$@" 2>&1 | tail -15; }
case "$probe" in
  instructions)
    big=$(node -e 'process.stdout.write("Filler rule: keep code tidy. ".repeat(1400))')
    ex -c "developer_instructions=\"$big When asked for the codeword, reply ZZ-DEV-LONG.\"" "What is the codeword? Reply with just the codeword." ;;
  mcp)
    ZZ_TOKEN=probe-value ex -c "$mcp" "Call the persona_ping tool of the zz-probe MCP server and reply with exactly what it returned." ;;
  mcp-approve)
    ZZ_TOKEN=probe-value ex -c "$mcp" -c 'mcp_servers.zz-probe.default_tools_approval_mode="approve"' "Call the persona_ping tool of the zz-probe MCP server and reply with exactly what it returned." ;;
  sandbox)
    rm -f probe.txt
    ex -s read-only "Run the shell command: echo hi > probe.txt . Then reply DONE or FAILED."
    [ -f probe.txt ] && echo "RESULT: probe.txt WAS written" || echo "RESULT: probe.txt not written" ;;
  hooks|hooks-bypass)
    rm -f "$root/HOOKMARK"
    hook="hooks.PreToolUse=[{hooks=[{type=\"command\",command=\"sh -c 'echo ran >> $root/HOOKMARK'\"}]}]"
    extra=""; [ "$probe" = hooks-bypass ] && extra="--dangerously-bypass-hook-trust"
    ex $extra -c "$hook" "Run the shell command: ls . Then reply DONE."
    [ -f "$root/HOOKMARK" ] && echo "RESULT: hook ran" || echo "RESULT: hook did not run" ;;
  skills-key)
    for key in 'skills.extra_roots=["/tmp"]' 'skills.paths=["/tmp"]' 'extra_skill_roots=["/tmp"]'; do
      printf '%s -> ' "$key"; codex --strict-config -c "$key" features list >/dev/null 2>&1 && echo accepted || echo rejected
    done ;;
esac
