#!/usr/bin/env bash
# PostToolUse hook: remind a WORKING session that agent-bridge mail is waiting.
# Read-only check via /health (get_messages would mark messages as read).
# Rate-limited per identity so it never spams the context.
set -euo pipefail

RATE_LIMIT_SECONDS=120

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hooks/agent-bridge-env.sh
. "$HOOK_DIR/agent-bridge-env.sh"
agent_bridge_load_auth claude

input=$(cat)
name=$(printf '%s' "$input" | bash "$HOOK_DIR/agent-bridge-compute-name.sh")

state_dir="${XDG_RUNTIME_DIR:-$HOME/.cache}/agent-bridge"
mkdir -p "$state_dir"
chmod 700 "$state_dir" 2>/dev/null || true
stamp="${state_dir}/mailcheck-${name}"
now=$(date +%s)
if [ -f "$stamp" ]; then
  last=$(cat "$stamp" 2>/dev/null || echo 0)
  [ $((now - last)) -lt "$RATE_LIMIT_SECONDS" ] && exit 0
fi
printf '%s\n' "$now" > "$stamp"

health_url="http://127.0.0.1:7447/health"
agent_bridge_sign_request GET "$health_url"
health=$(curl -s -m 2 "${AGENT_BRIDGE_CURL_AUTH[@]}" "$health_url" 2>/dev/null) || exit 0

python3 - "$health" "$name" <<'PY'
import json, sys

try:
    health = json.loads(sys.argv[1])
except json.JSONDecodeError:
    sys.exit(0)
name = sys.argv[2]

unread = next((a.get("unread", 0) for a in health.get("agents", []) if a.get("name") == name), 0)
if unread > 0:
    context = (
        f"{unread} unread agent-bridge message(s) are waiting in the mailbox `{name}`. "
        f'They can be read with the agent-bridge tool get_messages (for: "{name}"); '
        f"replies go through send_message to the exact sender name."
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": context,
        }
    }))
PY
