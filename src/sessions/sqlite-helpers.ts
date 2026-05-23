// src/sessions/sqlite-helpers.ts
// Schema, DFS cycle detection, and row-to-type conversions for SqliteSessionStore.
import type { Task, TaskStatus } from "./tasks.js";
import type { SessionRecord } from "./store.js";

/**
 * Current SQLite user_version. Stamped via `PRAGMA user_version = ?` on every
 * open so a fresh DB always reflects this number. No migrator is provided —
 * the skawld SDK is unpublished, so a stale local dev DB can simply be deleted.
 */
export const SCHEMA_VERSION = 1;

export const MIGRATIONS_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA user_version = ${SCHEMA_VERSION};

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  meta_json           TEXT NOT NULL DEFAULT '{}',
  invoked_skills_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS messages (
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  appended_at  TEXT NOT NULL,
  message_json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS tasks (
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  id            TEXT NOT NULL,
  subject       TEXT NOT NULL,
  description   TEXT NOT NULL,
  active_form   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed')),
  owner         TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE IF NOT EXISTS task_edges (
  session_id   TEXT NOT NULL,
  from_task_id TEXT NOT NULL,
  to_task_id   TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind = 'blocks'),
  PRIMARY KEY (session_id, from_task_id, to_task_id),
  FOREIGN KEY (session_id, from_task_id) REFERENCES tasks(session_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, to_task_id)   REFERENCES tasks(session_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS task_counters (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  next_id    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at   ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_session_seq  ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_tasks_session_status  ON tasks(session_id, status);
CREATE INDEX IF NOT EXISTS idx_task_edges_to         ON task_edges(session_id, to_task_id);
`;

/** DFS cycle detection on an adjacency map (from → set of tos). Returns true if a cycle is found. */
export function hasCycle(adj: Map<string, Set<string>>): boolean {
  const visited = new Set<string>();
  const inStack = new Set<string>();
  function dfs(node: string): boolean {
    if (inStack.has(node)) return true;
    if (visited.has(node)) return false;
    visited.add(node);
    inStack.add(node);
    for (const n of adj.get(node) ?? []) {
      if (dfs(n)) return true;
    }
    inStack.delete(node);
    return false;
  }
  for (const node of adj.keys()) {
    if (dfs(node)) return true;
  }
  return false;
}

export type SessionRow = {
  id: string;
  created_at: string;
  updated_at: string;
  meta_json: string;
  invoked_skills_json: string;
};
export type TaskRow = {
  session_id: string; id: string; subject: string; description: string;
  active_form: string | null; status: string; owner: string | null;
  metadata_json: string; created_at: string; updated_at: string;
};

export function rowToRecord(row: SessionRow): SessionRecord {
  const record: SessionRecord = {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    meta: JSON.parse(row.meta_json),
  };
  const invoked = JSON.parse(row.invoked_skills_json);
  if (Array.isArray(invoked) && invoked.length > 0) record.invokedSkills = invoked;
  return record;
}

export function rowToTask(row: TaskRow, blocks: string[], blocked_by: string[]): Task {
  const md: Record<string, unknown> = JSON.parse(row.metadata_json);
  return {
    id: row.id, session_id: row.session_id, subject: row.subject, description: row.description,
    active_form: row.active_form ?? undefined, status: row.status as TaskStatus,
    owner: row.owner ?? undefined, blocks, blocked_by,
    metadata: Object.keys(md).length > 0 ? md : undefined,
    created_at: row.created_at, updated_at: row.updated_at,
  };
}
