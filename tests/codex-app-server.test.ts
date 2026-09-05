import { describe, expect, test } from "bun:test";
import {
  wakeCodexThread,
  type JsonRpcLineTransport,
} from "../src/codex-app-server.ts";

const INPUT = {
  sessionId: "019f6767-789c-73b2-bc5c-ac8575f29efd",
  mailbox: "codex-019f6767-789c-73b2-bc5c-ac8575f29efd",
  prompt: "read your mailbox",
  timeoutMs: 50,
};

class FakeTransport implements JsonRpcLineTransport {
  sent: unknown[] = [];
  closed = false;
  private responses: Array<unknown | Error>;

  constructor(responses: Array<unknown | Error>) {
    this.responses = [...responses];
  }

  async send(message: unknown): Promise<void> {
    this.sent.push(message);
  }

  async receive(_timeoutMs: number): Promise<unknown> {
    const value = this.responses.shift();
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error("timeout");
    return value;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const response = (id: number, result: unknown) => ({ jsonrpc: "2.0", id, result });
const resume = (status: "idle" | "active" | "notLoaded" | "systemError") =>
  response(2, {
    thread: {
      id: INPUT.sessionId,
      status: status === "active" ? { type: status, activeFlags: [] } : { type: status },
    },
  });

describe("wakeCodexThread", () => {
  test("initializes, resumes the full thread UUID, and starts one text turn when idle", async () => {
    const transport = new FakeTransport([response(1, {}), resume("idle"), response(3, {})]);

    const result = await wakeCodexThread(transport, INPUT);

    expect(result).toEqual({ disposition: "started", detail: `started turn for ${INPUT.mailbox}` });
    expect(transport.sent).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "agent-bridge", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        },
      },
      { jsonrpc: "2.0", method: "initialized", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "thread/resume",
        params: { threadId: INPUT.sessionId },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "turn/start",
        params: {
          threadId: INPUT.sessionId,
          input: [{ type: "text", text: `${INPUT.prompt}\n\nMailbox: ${INPUT.mailbox}` }],
        },
      },
    ]);
    expect(transport.closed).toBe(true);
  });

  test("defers an active thread without sending turn/start", async () => {
    const transport = new FakeTransport([response(1, {}), resume("active")]);
    const result = await wakeCodexThread(transport, INPUT);
    expect(result).toEqual({
      disposition: "deferred-active-turn",
      detail: `thread ${INPUT.sessionId} is active`,
    });
    expect(transport.sent).toHaveLength(3);
    expect(transport.closed).toBe(true);
  });

  for (const status of ["notLoaded", "systemError"] as const) {
    test(`fails precisely when thread status is ${status}`, async () => {
      const transport = new FakeTransport([response(1, {}), resume(status)]);
      expect(await wakeCodexThread(transport, INPUT)).toEqual({
        disposition: "failed",
        detail: `thread ${INPUT.sessionId} status is ${status}`,
      });
      expect(transport.closed).toBe(true);
    });
  }

  test("correlates responses by ID and ignores notifications and unrelated responses", async () => {
    const transport = new FakeTransport([
      { jsonrpc: "2.0", method: "server/ready", params: {} },
      response(99, { unrelated: true }),
      response(1, {}),
      { jsonrpc: "2.0", method: "thread/status/changed", params: {} },
      resume("active"),
    ]);
    expect((await wakeCodexThread(transport, INPUT)).disposition).toBe("deferred-active-turn");
    expect(transport.closed).toBe(true);
  });

  test("returns a precise JSON-RPC failure", async () => {
    const transport = new FakeTransport([
      response(1, {}),
      { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "resume refused" } },
    ]);
    expect(await wakeCodexThread(transport, INPUT)).toEqual({
      disposition: "failed",
      detail: "thread/resume JSON-RPC error -32000: resume refused",
    });
    expect(transport.closed).toBe(true);
  });

  for (const [name, failure] of [
    ["malformed JSON", new Error("malformed JSON")],
    ["timeout", new Error("timeout")],
    ["early process exit", new Error("proxy exited early")],
  ] as const) {
    test(`closes transport on ${name}`, async () => {
      const transport = new FakeTransport([response(1, {}), failure]);
      expect(await wakeCodexThread(transport, INPUT)).toEqual({
        disposition: "failed",
        detail: `thread/resume failed: ${failure.message}`,
      });
      expect(transport.closed).toBe(true);
    });
  }
});
