#!/usr/bin/env bash
# SessionEnd hook: tell the bridge this session's mailbox owner is gone,
# so agents messaging it get a "disconnected" warning instead of silence.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hooks/agent-bridge-env.sh
. "$HOOK_DIR/agent-bridge-env.sh"
agent_bridge_load_auth claude

input=$(cat)
name=$(printf '%s' "$input" | bash "$HOOK_DIR/agent-bridge-compute-name.sh")

presence_url="http://127.0.0.1:7447/presence"
presence_body="{\"agent\":\"${name}\",\"online\":false}"
agent_bridge_sign_request POST "$presence_url" "$presence_body"
curl -s -m 2 -X POST "$presence_url" \
  -H 'content-type: application/json' \
  "${AGENT_BRIDGE_CURL_AUTH[@]}" \
  -d "$presence_body" > /dev/null 2>&1 || true

exit 0
