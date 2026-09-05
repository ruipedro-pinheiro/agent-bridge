#!/usr/bin/env bash
# SessionStart hook: unique agent-bridge identity per session + presence beacon.
set -euo pipefail

input=$(cat)
name=$(printf '%s' "$input" | bash "$HOME/.claude/hooks/agent-bridge-compute-name.sh")

# Announce presence. Best effort only: the daemon can be down.
# This must never block the session.
curl -s -m 2 -X POST http://127.0.0.1:7447/presence \
  -H 'content-type: application/json' \
  -d "{\"agent\":\"${name}\",\"online\":true}" > /dev/null 2>&1 || true

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
