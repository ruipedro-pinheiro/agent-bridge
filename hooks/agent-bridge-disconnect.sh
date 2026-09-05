#!/usr/bin/env bash
# SessionEnd hook: tell the bridge this session's mailbox owner is gone,
# so agents messaging it get a "disconnected" warning instead of silence.
set -euo pipefail

input=$(cat)
name=$(printf '%s' "$input" | bash "$HOME/.claude/hooks/agent-bridge-compute-name.sh")

curl -s -m 2 -X POST http://127.0.0.1:7447/presence \
  -H 'content-type: application/json' \
  -d "{\"agent\":\"${name}\",\"online\":false}" > /dev/null 2>&1 || true

exit 0
