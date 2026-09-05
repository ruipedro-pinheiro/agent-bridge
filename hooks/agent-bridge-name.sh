#!/usr/bin/env bash
# SessionStart hook: unique agent-bridge identity per session + presence beacon.
set -euo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hooks/agent-bridge-env.sh
. "$HOOK_DIR/agent-bridge-env.sh"
agent_bridge_load_auth claude

input=$(cat)
name=$(printf '%s' "$input" | bash "$HOOK_DIR/agent-bridge-compute-name.sh")

# Announce presence. Best effort only: the daemon can be down.
# This must never block the session.
presence_url="http://127.0.0.1:7447/presence"
presence_body="{\"agent\":\"${name}\",\"online\":true}"
agent_bridge_sign_request POST "$presence_url" "$presence_body"
curl -s -m 2 -X POST "$presence_url" \
  -H 'content-type: application/json' \
  "${AGENT_BRIDGE_CURL_AUTH[@]}" \
  -d "$presence_body" > /dev/null 2>&1 || true

context="Ton identité sur agent-bridge (messagerie inter-agents) pour CETTE session : \`${name}\`. Utilise exactement ce nom comme \`from\`/\`for\` sur les tools agent-bridge (send_message, get_messages, wait_for_messages, ping). Ne pas utiliser le nom générique \"claude\" : chaque session a sa propre boîte. Annuaire + présence : tool ping (champ connected)."

python3 - "$context" <<'PY'
import json, sys
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": sys.argv[1],
    }
}))
PY
