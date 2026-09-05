import type { Database } from "bun:sqlite";

export const CODEX_FAMILY = "codex";
export const MAX_AGENT_NAME_LENGTH = 64;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LABEL_SUFFIX_LENGTHS = [8, 12, 32] as const;

export interface CodexSession {
  mailbox: string;
  family: typeof CODEX_FAMILY;
  session_id: string;
  display_label: string;
  cwd: string;
  lifecycle: string;
  registered_at: string;
  last_seen: string;
}

function normalizeSessionId(sessionId: string): string {
  const normalized = sessionId.toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw new Error(`invalid Codex session UUID "${sessionId}": expected canonical 8-4-4-4-12 hexadecimal form`);
  }
  return normalized;
}

export function canonicalCodexMailbox(sessionId: string): string {
  return `${CODEX_FAMILY}-${normalizeSessionId(sessionId)}`;
}

function slugifyCwd(cwd: string): string {
  return cwd.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
}

export function buildCodexDisplayLabel(
  cwd: string,
  sessionId: string,
  suffixLength: 8 | 12 | 32,
): string {
  const compactSessionId = normalizeSessionId(sessionId).replaceAll("-", "");
  const suffix = compactSessionId.slice(0, suffixLength);
  const maxSlugLength = MAX_AGENT_NAME_LENGTH - CODEX_FAMILY.length - suffix.length - 2;
  const cwdSlug = slugifyCwd(cwd).slice(0, maxSlugLength).replace(/-+$/g, "") || "root";
  return `${CODEX_FAMILY}-${cwdSlug}-${suffix}`;
}

export class CodexSessionRegistry {
  constructor(private db: Database) {}

  register(input: { sessionId: string; cwd: string; lifecycle: string }): CodexSession {
    const sessionId = normalizeSessionId(input.sessionId);
    const mailbox = canonicalCodexMailbox(sessionId);
    const now = new Date().toISOString();

    const register = this.db.transaction(() => {
      const existing = this.getBySessionId(sessionId);
      const displayLabel = existing?.display_label ?? this.availableDisplayLabel(input.cwd, sessionId);

      this.db
        .query(
          `INSERT INTO agents(name, first_seen, last_seen) VALUES (?1, ?2, ?2)
           ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen`,
        )
        .run(mailbox, now);

      this.db
        .query(
          `INSERT INTO codex_sessions(
             mailbox, family, session_id, display_label, cwd, lifecycle, registered_at, last_seen
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
           ON CONFLICT(session_id) DO UPDATE SET
             cwd = excluded.cwd,
             lifecycle = excluded.lifecycle,
             last_seen = excluded.last_seen`,
        )
        .run(mailbox, CODEX_FAMILY, sessionId, displayLabel, input.cwd, input.lifecycle, now);

      return this.getByMailbox(mailbox)!;
    });

    return register();
  }

  getByMailbox(mailbox: string): CodexSession | null {
    return (
      (this.db.query(`SELECT * FROM codex_sessions WHERE mailbox = ?1`).get(mailbox.toLowerCase()) as
        | CodexSession
        | null) ?? null
    );
  }

  getBySessionId(sessionId: string): CodexSession | null {
    return (
      (this.db
        .query(`SELECT * FROM codex_sessions WHERE session_id = ?1`)
        .get(normalizeSessionId(sessionId)) as CodexSession | null) ?? null
    );
  }

  mostRecent(): CodexSession | null {
    return (
      (this.db
        .query(
          `SELECT * FROM codex_sessions
           WHERE family = ?1
           ORDER BY last_seen DESC, registered_at DESC, mailbox ASC
           LIMIT 1`,
        )
        .get(CODEX_FAMILY) as CodexSession | null) ?? null
    );
  }

  touchMailbox(mailbox: string, lifecycle?: string): void {
    const normalizedMailbox = mailbox.toLowerCase();
    const now = new Date().toISOString();
    const touch = this.db.transaction(() => {
      if (lifecycle === undefined) {
        this.db
          .query(`UPDATE codex_sessions SET last_seen = ?1 WHERE mailbox = ?2`)
          .run(now, normalizedMailbox);
      } else {
        this.db
          .query(`UPDATE codex_sessions SET last_seen = ?1, lifecycle = ?2 WHERE mailbox = ?3`)
          .run(now, lifecycle, normalizedMailbox);
      }
      this.db.query(`UPDATE agents SET last_seen = ?1 WHERE name = ?2`).run(now, normalizedMailbox);
    });
    touch();
  }

  listWithUnread(): Array<CodexSession & { unread: number }> {
    return this.db
      .query(
        `SELECT cs.*, COUNT(d.message_id) AS unread
         FROM codex_sessions cs
         LEFT JOIN deliveries d ON d.recipient = cs.mailbox AND d.read_at IS NULL
         WHERE cs.family = ?1
         GROUP BY cs.mailbox
         ORDER BY cs.last_seen DESC, cs.registered_at DESC, cs.mailbox ASC`,
      )
      .all(CODEX_FAMILY) as Array<CodexSession & { unread: number }>;
  }

  private availableDisplayLabel(cwd: string, sessionId: string): string {
    for (const suffixLength of LABEL_SUFFIX_LENGTHS) {
      const candidate = buildCodexDisplayLabel(cwd, sessionId, suffixLength);
      const collision = this.db
        .query(`SELECT 1 FROM codex_sessions WHERE display_label = ?1`)
        .get(candidate);
      if (!collision) return candidate;
    }
    throw new Error(`unable to create a unique display label for Codex session ${sessionId}`);
  }
}
