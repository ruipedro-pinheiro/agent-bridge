import { afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db.ts";

const databases = new Set<Database>();

afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
});

export function testDb(): Database {
  const db = openDb(":memory:");
  databases.add(db);
  return db;
}
