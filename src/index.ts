import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import * as z from "zod/v4";
import { openDb } from "./db.ts";
import { Bridge, type BridgeConfig } from "./bridge.ts";
import { handleCodexHook } from "./codex-hook.ts";
import { CodexSessionRegistry } from "./codex-session.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const config: BridgeConfig = loadConfig();

function loadConfig(): BridgeConfig {
  const path = join(ROOT, "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    console.error(`agent-bridge: no config file at ${path}`);
    console.error("Run: cp config.example.json config.json");
    process.exit(1);
  }
  try {
    return JSON.parse(raw) as BridgeConfig;
  } catch (err) {
    console.error(`agent-bridge: ${path} is not valid JSON`);
    console.error(String(err));
    process.exit(1);
  }
}
const db = openDb(join(ROOT, "bridge.db"));
const codexSessions = new CodexSessionRegistry(db);
const bridge = new Bridge(db, config, codexSessions);

// express ships no declaration package, keep the untyped edge here
type ExpressRequest = any;
type ExpressResponse = any;

function asText(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function asError(err: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: String(err instanceof Error ? err.message : err) }) }],
    isError: true,
  };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "agent-bridge", version: "1.0.0" });

  server.registerTool(
    "send_message",
    {
      description:
        'Send to an exact agent mailbox, the "codex" most-recent-session alias, or "all" to broadcast. ' +
        "Use exact codex-<full-session-uuid> targeting when multiple Codex sessions are registered. " +
        "Delivery is persistent: the recipient gets it on its next get_messages/wait_for_messages call. " +
        "If the recipient is idle and wake is configured, the bridge starts a turn on its side automatically.",
      inputSchema: {
        from: z.string().describe('Your exact agent mailbox (Codex uses "codex-<full-session-uuid>")'),
        to: z.string().describe('Exact mailbox, "codex" alias, or "all" broadcast'),
        content: z.string().describe("The message text"),
      },
    },
    async ({ from, to, content }) => {
      try {
        return asText(bridge.send(from, to, content));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "get_messages",
    {
      description: "Fetch and mark as read all unread messages addressed to you (direct or broadcast). Returns immediately.",
      inputSchema: {
        for: z.string().describe("Your exact mailbox; Codex must use its canonical full-UUID mailbox"),
      },
    },
    async ({ for: forAgent }) => {
      try {
        const messages = bridge.fetchUnread(forAgent);
        return asText({ messages, note: messages.length === 0 ? "no new messages" : undefined });
      } catch (err) {
        return asError(err);
      }
    },
  );

  // under both client timers, OpenCode 60 s per interval and Claude Code 5 min idle
  const HEARTBEAT_MS = 20_000;

  server.registerTool(
    "wait_for_messages",
    {
      description:
        "Block until a message addressed to you arrives (or the timeout expires, returning an empty list). " +
        "Waiting is FREE: the daemon holds the connection open with progress heartbeats, no turn is spent while blocked - " +
        "so make ONE long wait (default 10 min, up to 30 min), never a rapid retry loop. " +
        "IMPORTANT: this PREVIEWS messages without consuming them - they stay unread until you call get_messages. " +
        "Live-conversation loop: wait_for_messages -> read the preview -> get_messages to confirm receipt -> send_message to reply. " +
        "If a long wait returns empty and you owe nobody a reply, END YOUR TURN - agents with wake configured are started automatically when new mail arrives.",
      inputSchema: {
        for: z.string().describe("Your exact mailbox; Codex must use its canonical full-UUID mailbox"),
        timeout_seconds: z
          .number()
          .min(5)
          .max(1800)
          .default(600)
          .describe(
            "How long to block, in seconds (default 600, max 1800). The wait costs nothing while blocked and " +
              "returns as soon as a message arrives, so prefer one long value. Clients that sent no progress token " +
              "are clamped to 50 s (the daemon cannot legally keep their connection alive longer).",
          ),
      },
    },
    async ({ for: forAgent, timeout_seconds }, extra) => {
      const progressToken = extra?._meta?.progressToken;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      if (progressToken !== undefined) {
        let ticks = 0;
        const beat = () =>
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: ++ticks,
                message: `waiting for messages (${(ticks * HEARTBEAT_MS) / 1000}s)`,
              },
            })
            .catch(() => {}); // client gone: the abort signal handles cleanup
        // first beat flushes the SSE headers, defuses Claude Code's 60 s header timer
        beat();
        heartbeat = setInterval(beat, HEARTBEAT_MS);
      }
      try {
        const messages = await bridge.waitForMessages(
          forAgent,
          timeout_seconds,
          extra?.signal,
          progressToken !== undefined,
        );
        return asText({
          messages,
          note:
            messages.length === 0
              ? "timeout reached, no new messages - if the conversation is over, end your turn (you will be woken " +
                "on new mail if wake is configured); otherwise one more long wait_for_messages is fine"
              : `PREVIEW of ${messages.length} unread message(s) - NOT yet consumed. Call get_messages (for: "${forAgent}") to confirm receipt and mark them read.`,
        });
      } catch (err) {
        return asError(err);
      } finally {
        if (heartbeat !== undefined) clearInterval(heartbeat);
      }
    },
  );

  server.registerTool(
    "get_history",
    {
      description: "Read the shared conversation history (read-only, does not mark anything as read).",
      inputSchema: {
        limit: z.number().min(1).max(500).default(50).describe("Max messages to return"),
        before_id: z.number().optional().describe("Paginate: only messages with id lower than this"),
      },
    },
    async ({ limit, before_id }) => {
      try {
        return asText(bridge.history(limit, before_id));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "ping",
    {
      description:
        "Bridge status: known agents, Codex labels/cwd/lifecycle, waiters, unread counts, and recent wakes.",
      inputSchema: {
        from: z.string().optional().describe("Your agent name (updates your last_seen)"),
      },
    },
    async ({ from }) => {
      try {
        return asText(bridge.status(from));
      } catch (err) {
        return asError(err);
      }
    },
  );

  server.registerTool(
    "clear_conversation",
    {
      description: 'Delete ALL messages and delivery records. Destructive: requires confirm="wipe".',
      inputSchema: {
        confirm: z.string().describe('Must be exactly "wipe"'),
      },
    },
    async ({ confirm }) => {
      try {
        return asText(bridge.clear(confirm));
      } catch (err) {
        return asError(err);
      }
    },
  );

  return server;
}

const bindHost = Bun.env.AGENT_BRIDGE_BIND?.trim() || "127.0.0.1";

const app = createMcpExpressApp({ host: bindHost });

app.post("/mcp", async (req: ExpressRequest, res: ExpressResponse) => {
  const server = buildServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error("[mcp] request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const reject405 = (_req: unknown, res: { writeHead: (n: number) => { end: (s: string) => void } }) =>
  res.writeHead(405).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
app.get("/mcp", reject405);
app.delete("/mcp", reject405);

app.get("/health", (_req: ExpressRequest, res: ExpressResponse) => {
  res.json({ ok: true, ...bridge.status() });
});

app.post("/codex/hook", (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const result = handleCodexHook(bridge, codexSessions, req.body);
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error("[codex hook] local failure:", error);
    res.status(500).json({ error: "internal hook failure" });
  }
});

app.get("/subscribe", async (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const mailbox = req.query.mailbox === undefined ? undefined : String(req.query.mailbox);
    const prefix = req.query.prefix === undefined ? undefined : String(req.query.prefix);
    const rawTimeout = Number(req.query.timeout ?? 55);
    const timeout = Number.isFinite(rawTimeout) ? rawTimeout : 55;
    const onClose = (cleanup: () => void) => res.on("close", cleanup);
    const messages = mailbox
      ? await bridge.subscribeMailbox(mailbox, timeout, onClose)
      : await bridge.subscribeFamily(prefix ?? "", timeout, onClose);
    if (!res.writableEnded) res.json({ messages });
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
    }
  }
});

app.post("/presence", (req: ExpressRequest, res: ExpressResponse) => {
  try {
    const { agent, online } = req.body as { agent?: string; online?: boolean };
    if (typeof agent !== "string" || typeof online !== "boolean") {
      res.status(400).json({ error: "expected {agent: string, online: boolean}" });
      return;
    }
    bridge.setPresence(agent, online);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

app.listen(config.port, bindHost, () => {
  console.error(`agent-bridge listening on http://${bindHost}:${config.port}/mcp`);
  bridge.reconcileCodexWakes();
});
