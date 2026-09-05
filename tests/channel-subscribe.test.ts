import { describe, expect, test } from "bun:test";
import { Bridge, type BridgeConfig } from "../src/bridge.ts";
import { testDb } from "./helpers.ts";

const CONFIG: BridgeConfig = { port: 0, maxMessageBytes: 64 * 1024, wake: {} };

describe("channel mailbox subscription", () => {
  test("resolves only messages sent to the exact mailbox", async () => {
    const bridge = new Bridge(testDb(), CONFIG);
    const subscription = bridge.subscribeMailbox("claude-desktop-a1b2", 5);

    bridge.send("opencode", "claude-desktop-a1b2-child", "not yours");
    bridge.send("opencode", "claude-desktop-a1b2", "yours");

    await expect(subscription).resolves.toMatchObject([
      { sender: "opencode", recipient: "claude-desktop-a1b2", content: "yours" },
    ]);
  });

  test("registers the exact mailbox so channel-only sessions receive later broadcasts", async () => {
    const bridge = new Bridge(testDb(), CONFIG);
    const subscription = bridge.subscribeMailbox("claude-desktop-a1b2", 5);

    const result = bridge.send("opencode", "all", "broadcast");

    expect(result.deliveredTo).toEqual(["claude-desktop-a1b2"]);
    await expect(subscription).resolves.toMatchObject([
      { sender: "opencode", recipient: "claude-desktop-a1b2", content: "broadcast" },
    ]);
    expect(bridge.fetchUnread("claude-desktop-a1b2")).toMatchObject([
      { sender: "opencode", recipient: "all", content: "broadcast" },
    ]);
  });
});
