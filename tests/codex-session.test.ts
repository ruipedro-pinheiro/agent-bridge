import { describe, expect, test } from "bun:test";
import {
  CodexSessionRegistry,
  buildCodexDisplayLabel,
  canonicalCodexMailbox,
} from "../src/codex-session.ts";
import { testDb } from "./helpers.ts";

const SESSION_ID = "019f6767-789c-73b2-bc5c-ac8575f29efd";

describe("Codex session identity and registry", () => {
  test("builds the canonical mailbox and display label", () => {
    expect(canonicalCodexMailbox(SESSION_ID)).toBe(
      "codex-019f6767-789c-73b2-bc5c-ac8575f29efd",
    );
    expect(buildCodexDisplayLabel("/home/dev/project", SESSION_ID, 8)).toBe(
      "codex-home-dev-project-019f6767",
    );
  });

  test("registering the same session twice updates one row", () => {
    const db = testDb();
    const registry = new CodexSessionRegistry(db);
    const first = registry.register({
      sessionId: SESSION_ID,
      cwd: "/home/dev/old-project",
      lifecycle: "starting",
    });
    db.query(`UPDATE codex_sessions SET last_seen = ?1 WHERE mailbox = ?2`).run(
      "2000-01-01T00:00:00.000Z",
      first.mailbox,
    );

    const second = registry.register({
      sessionId: SESSION_ID,
      cwd: "/home/dev/new-project",
      lifecycle: "ready",
    });

    expect(second.mailbox).toBe(first.mailbox);
    expect(second.cwd).toBe("/home/dev/new-project");
    expect(second.lifecycle).toBe("ready");
    expect(second.last_seen).not.toBe("2000-01-01T00:00:00.000Z");
    expect(
      (db.query(`SELECT COUNT(*) AS count FROM codex_sessions`).get() as { count: number }).count,
    ).toBe(1);
  });

  test("disambiguates labels for sessions sharing a cwd and UUID prefix", () => {
    const registry = new CodexSessionRegistry(testDb());
    const first = registry.register({ sessionId: SESSION_ID, cwd: "/same/cwd", lifecycle: "ready" });
    const second = registry.register({
      sessionId: "019f6767-abcd-73b2-bc5c-ac8575f29efd",
      cwd: "/same/cwd",
      lifecycle: "ready",
    });

    expect(second.mailbox).not.toBe(first.mailbox);
    expect(second.display_label).not.toBe(first.display_label);
  });

  test("rejects an invalid non-canonical UUID", () => {
    const registry = new CodexSessionRegistry(testDb());

    expect(() =>
      registry.register({
        sessionId: "019f6767789c73b2bc5cac8575f29efd",
        cwd: "/home/dev/project",
        lifecycle: "ready",
      }),
    ).toThrow(/UUID/i);
  });
});
