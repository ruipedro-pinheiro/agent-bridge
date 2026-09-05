#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { signAgentBridgeRequest } from "./auth.ts";
import { buildSubscribeUrl, channelInstructions, readChannelConfig } from "./channel-config.ts";
import { clientTokenFromEnv, loadTokenEnvFile } from "./token-env.ts";

const POLL_SECONDS = 290; // daemon caps /subscribe at 300
loadTokenEnvFile();
const config = readChannelConfig();

const mcp = new Server(
  { name: "agent-bridge-channel", version: "1.0.0" },
  {
    capabilities: { experimental: { "claude/channel": {} } },
    instructions: channelInstructions(config.mailbox),
  },
);

await mcp.connect(new StdioServerTransport());

interface Row {
  sender: string;
  recipient: string;
  content: string;
  created_at: string;
}

while (true) {
  try {
    const url = buildSubscribeUrl(config, POLL_SECONDS);
    const headers: Record<string, string> = {};
    const clientId = Bun.env.AGENT_BRIDGE_CLIENT_ID ?? "claude";
    const token = clientTokenFromEnv(clientId);
    if (token) {
      Object.assign(
        headers,
        signAgentBridgeRequest({
          clientId,
          token,
          method: "GET",
          url,
        }),
      );
    }
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout((POLL_SECONDS + 15) * 1000),
    });
    if (!res.ok) throw new Error(`GET /subscribe -> ${res.status}`);
    const { messages } = (await res.json()) as { messages: Row[] };
    for (const m of messages) {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: m.content,
          meta: { from: m.sender, to: m.recipient, sent_at: m.created_at },
        },
      });
    }
  } catch {
    await Bun.sleep(5000);
  }
}
