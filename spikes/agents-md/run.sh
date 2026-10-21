#!/usr/bin/env bash
# Spike: which AGENTS.md files do Codex and Copilot CLI see, and can a persona be delivered
# without writing into the repo? Throwaway. Usage: run.sh <scratch-dir> [codex|copilot|both]
#
# Layout built under <scratch-dir>/agents-test:
#   repo/AGENTS.md            ZZ-ROOT      (repo root, a git repo)
#   repo/sub/AGENTS.md        ZZ-SUB       (nested; the tools run from repo/sub)
#   persona/AGENTS.md         ZZ-PERSONA-AGENTS   (outside the repo)
#   persona/zz.instructions.md ZZ-PERSONA-INSTR   (outside the repo)
# Out-of-repo delivery under test:
#   codex:   -c developer_instructions=... (ZZ-DEV)  and  -c mcp_servers.zz-probe=...
#   copilot: COPILOT_CUSTOM_INSTRUCTIONS_DIRS=persona  and  --additional-mcp-config
set -euo pipefail

scratch="$1"; which="${2:-both}"
here="$(cd "$(dirname "$0")" && pwd)"
server="$here/../claude-code/build/mcp-server.mjs"
root="$scratch/agents-test"

rm -rf "$root"; mkdir -p "$root/repo/sub" "$root/persona"
git -C "$root/repo" init -q
echo "Project rule: the root codeword is ZZ-ROOT."            > "$root/repo/AGENTS.md"
echo "Subfolder rule: the nested codeword is ZZ-SUB."          > "$root/repo/sub/AGENTS.md"
echo "Persona rule: the persona AGENTS codeword is ZZ-PERSONA-AGENTS." > "$root/persona/AGENTS.md"
printf -- '---\napplyTo: "**"\n---\nPersona rule: the persona instructions codeword is ZZ-PERSONA-INSTR.\n' \
  > "$root/persona/zz.instructions.md"
cat > "$root/mcp.json" <<EOF
{ "mcpServers": { "zz-probe": { "type": "stdio", "command": "node", "args": ["$server"], "tools": ["*"] } } }
EOF

prompt='Configuration test. Without reading any files or running shell commands:
1. List every codeword starting with "ZZ-" that appears in your instructions or context, and for each say where it came from if you can tell.
2. Call the persona_ping tool if you have it and report its text; otherwise say "no persona_ping tool".'

if [[ "$which" == codex || "$which" == both ]]; then
  echo "=== codex"
  (cd "$root/repo/sub" && codex exec --skip-git-repo-check --color never \
    -c 'developer_instructions="Persona developer rule: the developer codeword is ZZ-DEV."' \
    -c "mcp_servers.zz-probe={command=\"node\",args=[\"$server\"]}" \
    "$prompt" 2>&1 | tail -25)
fi

if [[ "$which" == copilot || "$which" == both ]]; then
  echo "=== copilot"
  (cd "$root/repo/sub" && COPILOT_CUSTOM_INSTRUCTIONS_DIRS="$root/persona" copilot -p "$prompt" \
    --additional-mcp-config "@$root/mcp.json" --allow-tool 'zz-probe' 2>&1 | tail -25)
fi
