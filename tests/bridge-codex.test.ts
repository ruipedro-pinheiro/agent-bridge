import { describe, expect, test } from "bun:test";
import { Bridge, type BridgeConfig } from "../src/bridge.ts";
import { CodexSessionRegistry, canonicalCodexMailbox } from "../src/codex-session.ts";
import { openDb } from "../src/db.ts";

const SESSION_A = "019f6767-789c-73b2-bc5c-ac8575f29efd";
const SESSION_B = "019f6768-789c-73b2-bc5c-ac8575f29efd";
const MAILBOX_A = canonicalCodexMailbox(SESSION_A);
const MAILBOX_B = canonicalCodexMailbox(SESSION_B);

const CONFIG: BridgeConfig = {
  port: 0,
  maxMessageBytes: 64 * 1024,
  wake: {},
};

function setup() {
  const db = openDb(":memory:");
  const registry = new CodexSessionRegistry(db);
  const bridge = new Bridge(db, CONFIG);
  return { bridge, db, registry };
}

function register(registry: CodexSessionRegistry, sessionId: string) {
  return registry.register({
    sessionId,
    cwd: `/work/${sessionId}`,
    lifecycle: "ready",
  });
}

describe("Bridge Codex routing", () => {
  test("accepts 64-character agent names and rejects 65-character names", () => {
    const { bridge, db } = setup();
    try {
      expect(bridge.normalizeAgent("a".repeat(64), "agent")).toBe("a".repeat(64));
      expect(() => bridge.normalizeAgent("a".repeat(65), "agent")).toThrow(/1-64 chars/);
    } finally {
      db.close();
    }
  });

  test("rejects codex as a sender because it is a recipient-only alias", () => {
    const { bridge, db } = setup();
    try {
      expect(() => bridge.send("codex", "claude", "hello")).toThrow(/recipient-only alias/i);
    } finally {
      db.close();
    }
  });

  test("rejects an unregistered canonical Codex sender", () => {
    const { bridge, db } = setup();
    try {
      expect(() => bridge.send(MAILBOX_A, "claude", "hello")).toThrow(/not registered/i);
    } finally {
      db.close();
    }
  });

  test("rejects an unregistered canonical Codex recipient", () => {
    const { bridge, db } = setup();
    try {
      expect(() => bridge.send("claude", MAILBOX_A, "hello")).toThrow(/not registered/i);
    } finally {
      db.close();
    }
  });

  test("fails clearly when codex has no registered session", () => {
    const { bridge, db } = setup();
    try {
      expect(() => bridge.send("claude", "codex", "hello")).toThrow(
        /no registered Codex session/i,
      );
    } finally {
      db.close();
    }
  });

  test("rejects the codex recipient alias in synchronous agent identity paths", () => {
    const { bridge, db } = setup();
    try {
      expect(() => bridge.fetchUnread("codex")).toThrow(/recipient-only alias/i);
      expect(() => bridge.peekUnread("codex")).toThrow(/recipient-only alias/i);
      expect(() => bridge.status("codex")).toThrow(/recipient-only alias/i);
      expect(() => bridge.setPresence("codex", true)).toThrow(/recipient-only alias/i);
    } finally {
      db.close();
    }
  });

  test("rejects the codex recipient alias as a wait identity", async () => {
    const { bridge, db } = setup();
    try {
      await expect(
        bridge.waitForMessages("codex", 5, AbortSignal.abort()),
      ).rejects.toThrow(/recipient-only alias/i);
    } finally {
      db.close();
    }
  });

  test("identity attempts with the codex alias create no agent or broadcast delivery", async () => {
    const { bridge, db } = setup();
    try {
      const attempts = [
        () => bridge.fetchUnread("codex"),
        () => bridge.peekUnread("codex"),
        () => bridge.status("codex"),
        () => bridge.setPresence("codex", true),
      ];
      for (const attempt of attempts) {
        try {
          attempt();
        } catch {}
      }
      try {
        await bridge.waitForMessages("codex", 5, AbortSignal.abort());
      } catch {}

      expect(db.query(`SELECT name FROM agents WHERE name = 'codex'`).get()).toBeNull();
      expect(bridge.send("claude", "all", "broadcast").deliveredTo).not.toContain("codex");
      expect(
        (
          db
            .query(
              `SELECT COUNT(*) AS count
               FROM deliveries d JOIN agents a ON a.name = d.recipient
               WHERE a.name = 'codex'`,
            )
            .get() as { count: number }
        ).count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  test("rejects presence for an unregistered canonical Codex mailbox without creating an agent", () => {
    const { bridge, db } = setup();
    try {
      expect(() => bridge.setPresence(MAILBOX_A, true)).toThrow(/not registered/i);
      expect(db.query(`SELECT name FROM agents WHERE name = ?1`).get(MAILBOX_A)).toBeNull();
    } finally {
      db.close();
    }
  });

  test("sets presence for a registered Codex mailbox and touches both registry and agent", () => {
    const { bridge, db, registry } = setup();
    try {
      register(registry, SESSION_A);
      const stale = "2000-01-01T00:00:00.000Z";
      db.query(`UPDATE agents SET last_seen = ?1 WHERE name = ?2`).run(stale, MAILBOX_A);
      db.query(`UPDATE codex_sessions SET last_seen = ?1 WHERE mailbox = ?2`).run(stale, MAILBOX_A);

      bridge.setPresence(MAILBOX_A, true);

      const agent = db
        .query(`SELECT last_seen, online, presence_at FROM agents WHERE name = ?1`)
        .get(MAILBOX_A) as { last_seen: string; online: number; presence_at: string | null };
      expect(agent.last_seen).not.toBe(stale);
      expect(agent.online).toBe(1);
      expect(agent.presence_at).not.toBeNull();
      expect(registry.getByMailbox(MAILBOX_A)?.last_seen).not.toBe(stale);
    } finally {
      db.close();
    }
  });

  test("preserves presence updates for non-Codex agents", () => {
    const { bridge, db } = setup();
    try {
      bridge.setPresence("claude", true);

      expect(
        db.query(`SELECT online, presence_at FROM agents WHERE name = 'claude'`).get(),
      ).toEqual(expect.objectContaining({ online: 1, presence_at: expect.any(String) }));
    } finally {
      db.close();
    }
  });

  test("routes codex to the most recently registered session and stores its canonical mailbox", async () => {
    const { bridge, db, registry } = setup();
    try {
      register(registry, SESSION_A);
      await Bun.sleep(2);
      register(registry, SESSION_B);

      const result = bridge.send("claude", "codex", "latest");

      expect(result.requestedTo).toBe("codex");
      expect(result.resolvedTo).toBe(MAILBOX_B);
      expect(result.deliveredTo).toEqual([MAILBOX_B]);
      expect(bridge.fetchUnread(MAILBOX_B)).toEqual([
        expect.objectContaining({
          sender: "claude",
          recipient: MAILBOX_B,
          content: "latest",
        }),
      ]);
      expect(bridge.fetchUnread(MAILBOX_A)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("touching a canonical session makes it the next codex alias target", async () => {
    const { bridge, db, registry } = setup();
    try {
      register(registry, SESSION_A);
      await Bun.sleep(2);
      register(registry, SESSION_B);
      await Bun.sleep(2);

      bridge.fetchUnread(MAILBOX_A);
      const result = bridge.send("claude", "codex", "after touch");

      expect(result.requestedTo).toBe("codex");
      expect(result.resolvedTo).toBe(MAILBOX_A);
      expect(result.deliveredTo).toEqual([MAILBOX_A]);
    } finally {
      db.close();
    }
  });

  test("keeps an exact canonical recipient after another session becomes most recent", async () => {
    const { bridge, db, registry } = setup();
    try {
      register(registry, SESSION_A);
      await Bun.sleep(2);
      register(registry, SESSION_B);
      await Bun.sleep(2);
      bridge.fetchUnread(MAILBOX_A);

      const result = bridge.send("claude", MAILBOX_B, "exact");

      expect(result.requestedTo).toBe(MAILBOX_B);
      expect(result.resolvedTo).toBe(MAILBOX_B);
      expect(result.deliveredTo).toEqual([MAILBOX_B]);
      expect(bridge.fetchUnread(MAILBOX_B)).toEqual([
        expect.objectContaining({ recipient: MAILBOX_B, content: "exact" }),
      ]);
      expect(bridge.fetchUnread(MAILBOX_A)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("broadcasts all as separate unread deliveries to every Codex session", () => {
    const { bridge, db, registry } = setup();
    try {
      register(registry, SESSION_A);
      register(registry, SESSION_B);

      const result = bridge.send("claude", "all", "broadcast");

      expect(result.deliveredTo).toContain(MAILBOX_A);
      expect(result.deliveredTo).toContain(MAILBOX_B);
      expect(bridge.fetchUnread(MAILBOX_A)).toEqual([
        expect.objectContaining({ recipient: "all", content: "broadcast" }),
      ]);
      expect(bridge.fetchUnread(MAILBOX_B)).toEqual([
        expect.objectContaining({ recipient: "all", content: "broadcast" }),
      ]);
    } finally {
      db.close();
    }
  });

  test("preserves direct Claude to OpenCode routing", () => {
    const { bridge, db } = setup();
    try {
      const result = bridge.send("claude", "opencode", "direct");

      expect(result.requestedTo).toBe("opencode");
      expect(result.resolvedTo).toBe("opencode");
      expect(result.deliveredTo).toEqual(["opencode"]);
      expect(bridge.fetchUnread("opencode")).toEqual([
        expect.objectContaining({
          sender: "claude",
          recipient: "opencode",
          content: "direct",
        }),
      ]);
    } finally {
      db.close();
    }
  });
});
