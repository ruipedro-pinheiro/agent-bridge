import { describe, expect, test } from "bun:test";
import {
  buildSubscribeUrl,
  channelInstructions,
  readChannelConfig,
} from "../src/channel-config.ts";

describe("channel config", () => {
  test("defaults bridge URL and broad claude mailbox when env is absent", () => {
    const config = readChannelConfig({});

    expect(config).toEqual({
      bridgeUrl: "http://127.0.0.1:7447",
      mailbox: "claude",
      exact: false,
    });
  });

  test("reads bridge URL and mailbox from env", () => {
    const config = readChannelConfig({
      AGENT_BRIDGE_URL: "http://127.0.0.1:8744/",
      AGENT_BRIDGE_MAILBOX: "claude-desktop-a1b2",
    });

    expect(config).toEqual({
      bridgeUrl: "http://127.0.0.1:8744",
      mailbox: "claude-desktop-a1b2",
      exact: true,
    });
  });

  test("refuses non-loopback bridge URLs", () => {
    expect(() =>
      readChannelConfig({
        AGENT_BRIDGE_URL: "http://bridge.example.test:7447/",
      }),
    ).toThrow(/non-loopback/i);
  });

  test("strips trailing slashes from the bridge URL", () => {
    expect(readChannelConfig({ AGENT_BRIDGE_URL: "http://127.0.0.1:7447///" }).bridgeUrl).toBe(
      "http://127.0.0.1:7447",
    );
  });

  test("builds an exact mailbox subscribe URL when a mailbox is configured", () => {
    const url = buildSubscribeUrl({
      bridgeUrl: "http://127.0.0.1:8744/base/",
      mailbox: "claude-desktop-a1b2",
      exact: true,
    }, 290);

    expect(url).toBe("http://127.0.0.1:8744/base/subscribe?mailbox=claude-desktop-a1b2&timeout=290");
  });

  // Regression: the shim asked for ?mailbox=claude, which the daemon matches
  // exactly. A Claude Code session is named "claude-<dir>-<id>", so no message
  // ever reached it. The default watch must cover the whole family.
  test("builds a family subscribe URL when no mailbox is configured", () => {
    const url = buildSubscribeUrl(readChannelConfig({}), 290);

    expect(url).toBe("http://127.0.0.1:7447/subscribe?prefix=claude&timeout=290");
    expect(url).not.toContain("mailbox=");
  });

  test("instructions name the owned mailbox and get_messages target", () => {
    const instructions = channelInstructions("claude-desktop-a1b2");

    expect(instructions).toContain("YOUR agent-bridge mailbox is claude-desktop-a1b2");
    expect(instructions).toContain('get_messages tool with for="claude-desktop-a1b2"');
  });
});
