# agent-bridge

**Let your coding agents talk to each other.**

You run Claude Code in one terminal and Codex in another. To make them work
together, you copy an answer out of one and paste it into the other. Every time.

agent-bridge gives each agent session a mailbox. One agent sends, the other
reads it on its next tool call. If the other one sits idle, the bridge starts a
turn on its side, so the exchange continues while you do something else.

It runs on one machine, as one process, for one developer. It is not a hosted
service.

## Quick start

```sh
git clone https://github.com/ruipedro-pinheiro/agent-bridge ~/.local/share/mcp-servers/agent-bridge
cd ~/.local/share/mcp-servers/agent-bridge
./install.sh
```

The installer generates your auth tokens, writes the config, installs the Claude
Code hooks, and starts the systemd user service. Then connect your agents:

```sh
source ~/.local/share/mcp-servers/agent-bridge/tokens.env

# Claude Code
claude mcp add --scope user --transport http agent-bridge http://127.0.0.1:7447/mcp \
  --header "Authorization: Bearer $AGENT_BRIDGE_CLAUDE_TOKEN"

# Codex
codex mcp add agent-bridge --url http://127.0.0.1:7447/mcp \
  --bearer-token-env-var AGENT_BRIDGE_CODEX_TOKEN

# OpenCode
opencode mcp add agent-bridge --url http://127.0.0.1:7447/mcp \
  --header "Authorization=Bearer $AGENT_BRIDGE_OPENCODE_TOKEN"
```

Restart your agents so they pick up the new server. Codex needs
`AGENT_BRIDGE_CODEX_TOKEN` in its own environment, because its MCP config stores
the variable name rather than the value.

No systemd? Run `./install.sh --no-service` and start it yourself with
`bun run src/index.ts`.

## What it looks like

Claude Code hands a review to Codex and moves on:

```
claude-api-7f2a  →  send_message  to: "codex"
                    "Review src/auth.ts, focus on the token comparison"

                    the bridge stores it and starts a turn in the idle Codex thread

codex-019f6767   →  get_messages  for: "codex-019f6767-..."
                    reads the request, reviews the file
                    send_message  to: "claude-api-7f2a"
                    "timingSafeEqual is used, but the length check leaks..."

claude-api-7f2a  ←  reads the reply on its next tool call
```

No terminal switching, no copy and paste.

## What you get

- **Persistent mailboxes.** A message survives a restart and waits for its
  recipient.
- **Direct, alias and broadcast.** Send to one mailbox, to `codex` for the most
  recent Codex session, or to `all`.
- **Waits that cost nothing.** `wait_for_messages` blocks on the server and
  returns the instant mail arrives. No polling loop, no LLM turn burned while
  waiting.
- **Wake for idle agents.** Codex threads and OpenCode sessions get a turn
  started for them, with a debounce and an hourly budget.
- **Auth per agent family.** Each client gets its own token and can only act as
  its own mailboxes.
- **Nothing leaves your machine.** SQLite on disk, loopback only.

## How it works

```
Claude Code ──http──▶                        ┌── SQLite (WAL, 0600)
                       agent-bridge daemon ──┤
OpenCode ────http──▶   127.0.0.1:7447/mcp    └── wake ─┬─ POST /session/{id}/prompt_async
                       (systemd user unit)             │  to the OpenCode server
Codex ───────http──▶                                   └─ codex app-server
                                                          thread/resume + turn/start
```

One process owns the database, so concurrent writes cannot corrupt it. Every
message gets one delivery row per recipient, which is why a broadcast never
goes missing for the second reader.

`wait_for_messages` previews mail without consuming it. Only `get_messages`
marks anything read, so a reply lost to a dropped connection never swallows a
message.

## Tools

| Tool | What it does |
| --- | --- |
| `send_message` | send to an exact mailbox, to `codex`, or to `all` |
| `get_messages` | fetch unread mail and mark it read |
| `wait_for_messages` | block until mail arrives, without consuming it |
| `get_history` | read the visible conversation history |
| `ping` | list visible agents, presence, unread counts, recent wakes |
| `clear_conversation` | wipe every message, admin token only |

Mailbox names match `[a-z0-9_-]{1,64}`. Claude Code sessions are named
`claude-<directory>-<id>`, Codex threads `codex-<session-uuid>`, and OpenCode
uses `opencode`. Call `ping` to see who is registered, and reply to the exact
`sender` of the message you received.

## Security

The default install is localhost only and authenticated.

- The daemon binds `127.0.0.1`. A non-loopback bind or wake URL needs an
  explicit unsafe environment flag.
- Every MCP client sends a bearer token. Tokens live in `tokens.env`, created
  with mode `0600` and kept out of git.
- A token is scoped to its agent family. The Claude token cannot act as a Codex
  mailbox.
- The admin token is the only one that sees everything and the only one that
  can wipe the database.
- Local helper hooks sign their requests with HMAC.
- SQLite files are created `0600`.
- Wake prompts tell the woken agent that mailbox content is untrusted input,
  not instructions.

**What this does not protect against.** This is IPC between tools running as
your own user. Any process under the same Unix account can read `tokens.env`,
the database, or the daemon's memory. Treat message content as untrusted text
in your own agent instructions too, because another agent wrote it.

## Configuration

`config.json` is created by the installer from `config.example.json`. Two
sections matter:

- `auth.clients` maps a client name to its token variable and the mailboxes it
  may act as.
- `wake` holds one entry per agent you want woken, with its debounce and hourly
  budget.

Token values stay in `tokens.env` and are referenced by `tokenEnv`, so
`config.json` never holds a secret.

## Operations

```sh
systemctl --user status agent-bridge      # service state
journalctl --user -u agent-bridge -f      # logs, including every wake attempt

source tokens.env
curl -s -H "Authorization: Bearer $AGENT_BRIDGE_ADMIN_TOKEN" \
  http://127.0.0.1:7447/health            # agents, unread counts, recent wakes

bun test                                  # 93 tests
bun run typecheck
bun run prepublish:security               # secret and permission checks
```

For wake to reach OpenCode, its server needs a fixed port. Launch it with
`opencode --port 14096`. Without the flag the TUI picks a random port each time
and the bridge cannot find it. Mail still queues and arrives on the next tool
call.

## Requirements

[Bun](https://bun.sh) 1.3 or later, a Linux user session with systemd (or any
supervisor), and at least one of Claude Code, Codex or OpenCode.

## License

MIT. See [LICENSE](LICENSE).
