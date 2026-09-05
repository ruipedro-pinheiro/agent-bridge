#!/usr/bin/env bash
# Shared hook helper: load local bridge tokens and build signed curl auth arguments.

agent_bridge_load_auth() {
  local client="${1:-claude}"
  local token_file="${AGENT_BRIDGE_TOKENS_FILE:-$HOME/.local/share/mcp-servers/agent-bridge/tokens.env}"
  if [ -r "$token_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$token_file"
    set +a
  fi

  local token_var
  token_var="AGENT_BRIDGE_${client^^}_TOKEN"
  local token="${!token_var:-${AGENT_BRIDGE_TOKEN:-}}"
  AGENT_BRIDGE_AUTH_CLIENT="$client"
  AGENT_BRIDGE_AUTH_TOKEN="$token"
  AGENT_BRIDGE_CURL_AUTH=()
}

agent_bridge_sign_request() {
  local method="$1"
  local url="$2"
  local body="${3:-}"
  AGENT_BRIDGE_CURL_AUTH=()
  if [ -z "${AGENT_BRIDGE_AUTH_TOKEN:-}" ]; then
    return 0
  fi
  mapfile -d '' -t AGENT_BRIDGE_CURL_AUTH < <(
    AGENT_BRIDGE_AUTH_CLIENT="$AGENT_BRIDGE_AUTH_CLIENT" \
    AGENT_BRIDGE_AUTH_TOKEN="$AGENT_BRIDGE_AUTH_TOKEN" \
    AGENT_BRIDGE_AUTH_METHOD="$method" \
    AGENT_BRIDGE_AUTH_URL="$url" \
    AGENT_BRIDGE_AUTH_BODY="$body" \
    python3 - <<'PY'
import hashlib
import hmac
import os
import secrets
import sys
import time
from urllib.parse import urlsplit

client = os.environ["AGENT_BRIDGE_AUTH_CLIENT"]
token = os.environ["AGENT_BRIDGE_AUTH_TOKEN"]
method = os.environ["AGENT_BRIDGE_AUTH_METHOD"].upper()
url = os.environ["AGENT_BRIDGE_AUTH_URL"]
body = os.environ.get("AGENT_BRIDGE_AUTH_BODY", "")

parts = urlsplit(url)
path = parts.path or "/"
if parts.query:
    path = f"{path}?{parts.query}"
timestamp = str(int(time.time() * 1000))
nonce = secrets.token_hex(16)
digest = hashlib.sha256(body.encode()).hexdigest()
payload = "\n".join([method, path, digest, timestamp, nonce, client])
signature = hmac.new(token.encode(), payload.encode(), hashlib.sha256).hexdigest()
headers = [
    "-H", f"x-agent-bridge-client: {client}",
    "-H", f"x-agent-bridge-timestamp: {timestamp}",
    "-H", f"x-agent-bridge-nonce: {nonce}",
    "-H", f"x-agent-bridge-signature: sha256={signature}",
]
sys.stdout.write("\0".join(headers) + "\0")
PY
  )
}
