#!/usr/bin/env bash
# PostToolUse hook: remind a WORKING session that agent-bridge mail is waiting.
# Read-only check via /health (get_messages would mark messages as read).
# Rate-limited per identity so it never spams the context.
set -euo pipefail

RATE_LIMIT_SECONDS=120

input=$(cat)
name=$(printf '%s' "$input" | bash "$HOME/.claude/hooks/agent-bridge-compute-name.sh")

stamp="${TMPDIR:-/tmp}/agent-bridge-mailcheck-${name}"
now=$(date +%s)
if [ -f "$stamp" ]; then
  last=$(cat "$stamp" 2>/dev/null || echo 0)
  [ $((now - last)) -lt "$RATE_LIMIT_SECONDS" ] && exit 0
fi
echo "$now" > "$stamp"

health=$(curl -s -m 2 http://127.0.0.1:7447/health 2>/dev/null) || exit 0

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
