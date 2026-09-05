# agent-bridge

Local MCP daemon that carries messages between Claude Code, Codex and OpenCode
sessions on one machine, and starts a turn on an idle recipient.

Scope: single workstation, single Unix user. Not a remote service.

## Requirements

| Item | Version |
| --- | --- |
| Bun | 1.3 or later |
| Init system | systemd user session, or any supervisor |
| Agents | at least one of Claude Code, Codex, OpenCode |

## Install

```sh
git clone https://github.com/ruipedro-pinheiro/agent-bridge ~/.local/share/mcp-servers/agent-bridge
cd ~/.local/share/mcp-servers/agent-bridge
./install.sh
```

`install.sh` performs:

| Step | Result |
| --- | --- |
| dependency install | `bun install` |
| token generation | `tokens.env`, mode 0600, 4 tokens |
| config creation | `config.json` from `config.example.json`, `codex` path detected |
| hook install | 3 hooks copied to `~/.claude/hooks`, declared in `settings.json` |
| service install | systemd user unit, enabled and started |
| health check | authenticated `GET /health` |

Flags: `--no-hooks` skips the Claude Code step, `--no-service` skips systemd.
Without systemd, start the daemon with `bun run src/index.ts`.

Re-running the script keeps existing tokens, config and settings. It writes a
backup before any migration.

## Client registration

```sh
source ~/.local/share/mcp-servers/agent-bridge/tokens.env

claude mcp add --scope user --transport http agent-bridge http://127.0.0.1:7447/mcp \
  --header "Authorization: Bearer $AGENT_BRIDGE_CLAUDE_TOKEN"

codex mcp add agent-bridge --url http://127.0.0.1:7447/mcp \
  --bearer-token-env-var AGENT_BRIDGE_CODEX_TOKEN

opencode mcp add agent-bridge --url http://127.0.0.1:7447/mcp \
  --header "Authorization=Bearer $AGENT_BRIDGE_OPENCODE_TOKEN"
```

Restart each agent after registration. Codex requires
`AGENT_BRIDGE_CODEX_TOKEN` in its process environment: its MCP config stores the
variable name, not the value.

## Tools

| Tool | Arguments | Effect |
| --- | --- | --- |
| `send_message` | `from`, `to`, `content` | queues one delivery row per recipient |
| `get_messages` | `for` | returns unread mail and marks it read |
| `wait_for_messages` | `for`, `timeout_seconds` | blocks server-side, returns a preview, consumes nothing |
| `get_history` | `limit`, `before_id` | reads visible history, marks nothing |
| `ping` | `from` | visible agents, presence, unread counts, recent wakes |
| `clear_conversation` | `confirm` | deletes all messages, admin token only |

## Mailboxes

| Client | Name format | Source |
| --- | --- | --- |
| Claude Code | `claude-<directory>-<id>` | SessionStart hook |
| Codex | `codex-<session-uuid>` | SessionStart hook |
| OpenCode | `opencode` | config |

Names match `[a-z0-9_-]{1,64}`. `to: "codex"` resolves at send time to the most
recent registered Codex session. `to: "all"` creates one unread row per known
mailbox. Replies go to the exact `sender` field of the received message.

## Architecture

```
Claude Code ──http──▶                        ┌── SQLite (WAL, 0600)
                       agent-bridge daemon ──┤
OpenCode ────http──▶   127.0.0.1:7447/mcp    └── wake ─┬─ POST /session/{id}/prompt_async
                       (systemd user unit)             │
Codex ───────http──▶                                   └─ codex app-server
                                                          thread/resume + turn/start
```

One process owns the database. Single writer, no concurrent-write corruption.

Delivery is per recipient, so a broadcast cannot be lost by a second reader.
`wait_for_messages` previews without consuming. `get_messages` is the only
consumer, so a reply lost to a dropped connection never marks mail read.

## Wake

| Target | Mechanism | Requirement |
| --- | --- | --- |
| Codex | `thread/resume` then `turn/start` on `app-server` | `wake.codex.command` points to the running Codex version |
| OpenCode | `POST /session/{id}/prompt_async` | server on a fixed port, `opencode --port 14096` |

Guards: 30 s debounce after a successful wake, 20 wakes per rolling hour, both
in `config.json`. An active Codex thread is retried with bounded backoff and
never receives a concurrent turn. A failed wake is logged, never fatal: the
message stays queued.

Without `--port`, the OpenCode TUI binds a random port and the daemon cannot
reach it. Mail still queues and is delivered on the next tool call.

## Security

| Control | State |
| --- | --- |
| Bind address | `127.0.0.1`, non-loopback requires an explicit unsafe flag |
| MCP auth | bearer token per client, required |
| Token scope | per agent family, `claude-*` cannot act as `codex-*` |
| Admin token | required for full visibility and `clear_conversation` |
| Hook requests | HMAC signed |
| Token storage | `tokens.env`, mode 0600, git-ignored |
| Database | SQLite created 0600, git-ignored |
| Wake prompts | declare mailbox content as untrusted input |

Out of scope: this is IPC between processes running as the same Unix user. Any
process under that account can read `tokens.env`, the database, or daemon
memory. Message content is written by other agents and must be treated as
untrusted text in agent instructions.

## Configuration

`config.json`, created from `config.example.json`.

| Key | Content |
| --- | --- |
| `port` | listen port, default 7447 |
| `maxMessageBytes` | per-message cap, default 65536 |
| `auth.clients.<name>.tokenEnv` | environment variable holding the token |
| `auth.clients.<name>.agents` | mailbox patterns the client may act as |
| `auth.clients.<name>.admin` | grants full visibility and wipe |
| `wake.<agent>` | wake type, target, prompt, debounce, hourly budget |

Token values stay in `tokens.env`. `config.json` holds variable names only.

## Operations

```sh
systemctl --user status agent-bridge
journalctl --user -u agent-bridge -f

source tokens.env
curl -s -H "Authorization: Bearer $AGENT_BRIDGE_ADMIN_TOKEN" http://127.0.0.1:7447/health

bun test
bun run typecheck
bun run prepublish:security
```

## License

MIT. See [LICENSE](LICENSE).
