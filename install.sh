#!/usr/bin/env bash
# Installs dependencies, config, Claude Code hooks and the systemd user unit.
# Safe to run again: it never overwrites a file you already edited.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
UNIT_DIR="$HOME/.config/systemd/user"
DO_HOOKS=1
DO_SERVICE=1

for arg in "$@"; do
  case "$arg" in
    --no-hooks)   DO_HOOKS=0 ;;
    --no-service) DO_SERVICE=0 ;;
    -h|--help)
      echo "usage: ./install.sh [--no-hooks] [--no-service]"
      exit 0 ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2 ;;
  esac
done

say()  { printf '  %s\n' "$1"; }
step() { printf '\n== %s\n' "$1"; }

step "Checking requirements"
if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required. Install it from https://bun.sh, then run this again." >&2
  exit 1
fi
say "bun $(bun --version)"

step "Installing dependencies"
(cd "$ROOT" && bun install --silent)
say "done"

step "Writing config.json"
if [ -f "$ROOT/config.json" ]; then
  say "config.json exists, left untouched"
else
  CODEX_BIN="$(command -v codex || true)"
  bun -e '
    const [src, dst, codexBin] = process.argv.slice(1);
    const cfg = JSON.parse(require("fs").readFileSync(src, "utf8"));
    if (codexBin) cfg.wake.codex.command = codexBin;
    require("fs").writeFileSync(dst, JSON.stringify(cfg, null, 2) + "\n");
  ' "$ROOT/config.example.json" "$ROOT/config.json" "$CODEX_BIN"
  say "created from config.example.json"
  [ -n "$CODEX_BIN" ] && say "codex binary detected: $CODEX_BIN" \
                      || say "codex not found in PATH, edit wake.codex.command yourself"
fi

if [ "$DO_HOOKS" = 1 ]; then
  step "Installing Claude Code hooks"
  if [ ! -d "$CLAUDE_DIR" ]; then
    say "no $CLAUDE_DIR, skipping (use --no-hooks to silence this)"
  else
    mkdir -p "$CLAUDE_DIR/hooks"
    cp "$ROOT"/hooks/agent-bridge-*.sh "$CLAUDE_DIR/hooks/"
    chmod +x "$CLAUDE_DIR"/hooks/agent-bridge-*.sh
    say "copied 4 hooks to $CLAUDE_DIR/hooks/"

    SETTINGS="$CLAUDE_DIR/settings.json"
    [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
    cp "$SETTINGS" "$SETTINGS.bak"
    bun -e '
      const fs = require("fs");
      const [file, hooksDir] = process.argv.slice(1);
      const s = JSON.parse(fs.readFileSync(file, "utf8"));
      s.hooks ??= {};
      const want = [
        ["SessionStart", "agent-bridge-name.sh",       null, undefined],
        ["SessionEnd",   "agent-bridge-disconnect.sh", null, 5],
        ["PostToolUse",  "agent-bridge-mailcheck.sh",  "Bash", 5],
      ];
      let added = 0;
      for (const [event, script, matcher, timeout] of want) {
        s.hooks[event] ??= [];
        const already = JSON.stringify(s.hooks[event]).includes(script);
        if (already) continue;
        const hook = { type: "command", command: `bash "${hooksDir}/${script}"` };
        if (timeout) hook.timeout = timeout;
        s.hooks[event].push(matcher ? { matcher, hooks: [hook] } : { hooks: [hook] });
        added++;
      }
      fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
      console.log(`  ${added} hook(s) added to settings.json, ${want.length - added} already present`);
    ' "$SETTINGS" "$CLAUDE_DIR/hooks"
    say "backup kept at $SETTINGS.bak"
  fi
fi

if [ "$DO_SERVICE" = 1 ]; then
  step "Installing the systemd user service"
  if ! command -v systemctl >/dev/null 2>&1; then
    say "no systemctl, start the daemon yourself: bun run src/index.ts"
  else
    mkdir -p "$UNIT_DIR"
    sed "s|%h/.local/share/mcp-servers/agent-bridge|$ROOT|g" \
      "$ROOT/agent-bridge.service.example" > "$UNIT_DIR/agent-bridge.service"
    systemctl --user daemon-reload
    systemctl --user enable --now agent-bridge
    say "service enabled and started"

    sleep 2
    if curl -sf --max-time 5 http://127.0.0.1:7447/health >/dev/null; then
      say "health check passed on http://127.0.0.1:7447"
    else
      say "health check FAILED, look at: journalctl --user -u agent-bridge -n 30"
    fi
  fi
fi

step "Remaining manual step: connect your agents"
cat <<'EOF'
  Claude Code:
    claude mcp add --scope user --transport http agent-bridge http://127.0.0.1:7447/mcp

  Codex, in ~/.codex/config.toml:
    [mcp_servers.agent-bridge]
    url = "http://127.0.0.1:7447/mcp"

  OpenCode, in ~/.config/opencode/opencode.jsonc:
    { "mcp": { "agent-bridge": { "type": "remote", "url": "http://127.0.0.1:7447/mcp" } } }

  Then restart your agents so they pick up the new server.
EOF
