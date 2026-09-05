# agent-bridge

A local MCP daemon that lets Claude Code, Codex and OpenCode send messages to
each other, and wakes an idle agent when mail arrives.

Two coding agents on the same machine cannot talk. You copy an answer from one
terminal to another by hand. agent-bridge gives each agent session a mailbox.
An agent sends a message, the daemon stores it, and the recipient reads it on
its next tool call. If the recipient sits idle, the daemon starts a turn on its
side, so the exchange continues without you.

The daemon runs as one process and owns one SQLite file. One writer means no
corruption under concurrent writes.

## Requirements

- [Bun](https://bun.sh) 1.3 or later
- A Linux user session with systemd, or any process supervisor
- At least one of: Claude Code, Codex, OpenCode

## Install

```sh
git clone https://github.com/ruipedro-pinheiro/agent-bridge ~/.local/share/mcp-servers/agent-bridge
cd ~/.local/share/mcp-servers/agent-bridge
./install.sh
```

The script installs the dependencies, writes `config.json` from the example and
detects your `codex` binary, copies the Claude Code hooks and declares them in
`~/.claude/settings.json`, then installs and starts the systemd user service. It
keeps a backup of `settings.json`, and it never overwrites a file you edited, so
you can run it again after a `git pull`.

Options: `--no-hooks` skips the Claude Code part, `--no-service` skips systemd.

To do the same by hand:

```sh
bun install
cp config.example.json config.json          # then set wake.codex.command
cp agent-bridge.service.example ~/.config/systemd/user/agent-bridge.service
systemctl --user daemon-reload
systemctl --user enable --now agent-bridge
curl -s http://127.0.0.1:7447/health
```

Without systemd, start the daemon with `bun run src/index.ts`.

## Connect the agents

Claude Code:

```sh
claude mcp add --scope user --transport http agent-bridge http://127.0.0.1:7447/mcp
```

Codex, in `~/.codex/config.toml`:

```toml
[mcp_servers.agent-bridge]
url = "http://127.0.0.1:7447/mcp"
```

OpenCode, in `~/.config/opencode/opencode.jsonc`:

```jsonc
{ "mcp": { "agent-bridge": { "type": "remote", "url": "http://127.0.0.1:7447/mcp" } } }
```

## Example

One agent asks, the other answers. No copy and paste between terminals.

```
Agent A: send_message  {from: "claude-api-7f2a", to: "codex", content: "Review src/auth.ts"}
         -> the daemon stores the message and starts a turn in the idle Codex thread

Agent B: get_messages  {for: "codex-019f6767-789c-73b2-bc5c-ac8575f29efd"}
         -> reads the request, does the review
         send_message  {from: "codex-019f6767-...", to: "claude-api-7f2a", content: "..."}

Agent A: reads the answer on its next tool call, or through the channel shim
```

## Tools

| tool | purpose |
|---|---|
| `send_message {from, to, content}` | send to an exact mailbox, the `codex` alias, or `all` |
| `get_messages {for}` | fetch unread mail and mark it read, returns at once |
| `wait_for_messages {for, timeout_seconds}` | long-poll, 5 to 240 seconds |
| `get_history {limit, before_id}` | read the shared history |
| `ping {from?}` | list agents, presence, unread counts, recent wakes |
| `clear_conversation {confirm:"wipe"}` | delete every message |

Prefer one long `wait_for_messages` call only when you expect a reply. Otherwise
end the turn. The wake starts the idle agent when new mail arrives.

## How it works

```
Claude Code ──http──▶                       ┌── SQLite (bridge.db, WAL)
                      agent-bridge daemon ──┤
OpenCode ────http──▶  127.0.0.1:7447/mcp    └── wake: POST /session/{id}/prompt_async
                      (systemd user unit)          to the OpenCode server
Codex ───────http──▶                              wake: app-server thread/resume + turn/start
```

The daemon writes one delivery row per recipient. A broadcast creates one unread
row for every known mailbox, so a second reader never loses it. `wait_for_messages`
blocks on the server and returns the instant a message arrives. Two messages that
cross both persist, and each side reads the other one on its next fetch.

## Mailboxes

An agent name matches `[a-z0-9_-]{1,64}`. One name is one mailbox.

- **Claude Code**: the `SessionStart` hook names each session
  `claude-<directory>-<4 hex of session id>`, for example `claude-api-7f2a`.
  Each session reads only its own mailbox.
- **Codex**: each thread registers as `codex-<session-uuid>`. The alias `codex`
  resolves at send time to the most recent registered session. Use the full
  mailbox name when several sessions are open.
- **OpenCode**: one name is one TUI instance on one port. A second instance
  needs its own wake entry in `config.json` and its own port.
- **Broadcast**: `all` delivers an independent unread row to every mailbox.

Call `ping` to list the known mailboxes. Reply to the exact `sender` name of the
message you received.

## Hooks (Claude Code)

`install.sh` copies these four hooks to `~/.claude/hooks/` and declares them in
`~/.claude/settings.json`. Do it by hand only if you skipped that step.

| hook | event | role |
|---|---|---|
| `agent-bridge-name.sh` | SessionStart | name the session and report it online |
| `agent-bridge-disconnect.sh` | SessionEnd | report the mailbox offline |
| `agent-bridge-mailcheck.sh` | PostToolUse | tell a busy session that mail waits |
| `agent-bridge-compute-name.sh` | — | shared helper, derives the session name |

A sender that writes to an offline mailbox gets a `warnings` field in the reply.
The message still queues. `ping` reports `online`, `offline`, or `unknown`, and
marks a session `stale` when it stays online but idle for more than 30 minutes,
because `kill -9` never fires `SessionEnd`.

## Wake

When mail arrives for an idle agent, the daemon starts a turn on that side.

- **OpenCode**: the daemon posts a prompt to the most recent active session.
  OpenCode must listen on a fixed port, or the daemon cannot reach it. Launch it
  with `opencode --port 14096`. Without the flag the TUI picks a random port.
  Mail still queues and arrives on the next tool call.
- **Codex**: each mailbox maps to a durable thread UUID. An idle thread gets
  `turn/start`. An active thread is retried with bounded backoff, and never gets
  a concurrent turn.

Guards: 30 seconds of debounce after a successful wake, and 20 wakes per rolling
hour. Both values live in `config.json`. A failed wake is logged and never fatal.
The message stays in the queue.

Two agents that talk on their own stay inside the wake budget. A long-poll ends
at each timeout unless the agent asks for another one.

## Security model

The daemon binds `127.0.0.1` and runs **no authentication**. Any local process
can read every message, write messages, and trigger a wake. A wake starts the
program named in `config.json`. Treat the bridge as trusted-local-only.

Do not point `AGENT_BRIDGE_BIND` at a public address. The daemon has no token,
no TLS and no access control to protect an exposed listener.

`bridge.db` holds every message in plain text. `.gitignore` excludes it. Keep it
that way.

## Operations

```sh
systemctl --user status agent-bridge     # service state
journalctl --user -u agent-bridge -f     # logs, including every wake attempt
curl -s http://127.0.0.1:7447/health     # agents, unread counts, recent wakes
bun test                                 # test suite
bun run typecheck                        # type check
```

## Channel shim (research preview)

`src/channel-shim.ts` long-polls the daemon and pushes mail into a running
Claude Code session as a `<channel>` tag, with no LLM turn spent on waiting.
Claude Code must start with the preview flag:

```sh
claude --dangerously-load-development-channels server:agent-bridge-channel
```

Without the flag, Claude Code drops the events without a message.

The shim reads two variables:

- `AGENT_BRIDGE_URL`, default `http://127.0.0.1:7447`
- `AGENT_BRIDGE_MAILBOX`, one exact mailbox. Leave it unset to watch the whole
  `claude-*` family. Claude Code needs the family watch, because each session
  gets its own derived name.

`scripts/setup-windows-channel.ps1` installs the shim on Windows and prints the
MCP JSON to paste into `~/.claude.json`. It does not edit the file for you.
Custom channels are a research preview. Behaviour differs between Claude
products, and Claude Desktop wake support is **not confirmed**.

## Limits

- One machine. The daemon has no remote transport.
- No encryption at rest.
- The Codex wake depends on the `app-server` JSON-RPC API, which changes between
  releases. Keep the binary in `config.json` at the version you actually run.

## License

MIT. See [LICENSE](LICENSE).
