// src/sessions/sqlite.ts
import type Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// Dual-runtime driver: bun:sqlite under Bun (zero native deps), better-sqlite3 under Node.
// Both expose the same db.prepare(sql).run/get/all(...spread) surface, so call sites
// are identical. The conditional is at module load via top-level await.
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const DatabaseCtor: new (path: string) => Database.Database = isBun
  ? ((await import("bun:sqlite")).Database as unknown as new (path: string) => Database.Database)
  : ((await import("better-sqlite3")).default as unknown as new (path: string) => Database.Database);
import type { InvokedSkillRecord, Message } from "../core/types.js";
import type { SessionRecord, SessionStore, StoredMessage } from "./store.js";
import type { CreateTaskInput, Task, TaskPatch } from "./tasks.js";
import { MIGRATIONS_SQL, hasCycle, rowToRecord, rowToTask, type SessionRow, type TaskRow } from "./sqlite-helpers.js";

export interface SqliteSessionStoreOptions {
  databasePath?: string;
  /** Working directory used to derive default DB path. */
  cwd?: string;
}

export class SqliteSessionStore implements SessionStore {
  private db: Database.Database;

  constructor(opts: SqliteSessionStoreOptions = {}) {
    const cwd = opts.cwd ?? process.cwd();
    const path = opts.databasePath ?? join(cwd, ".skawld", "sessions.db");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseCtor(path);
    this.db.exec(MIGRATIONS_SQL);
  }

  async create(record: { id?: string; meta?: Record<string, unknown> }): Promise<SessionRecord> {
    const id = record.id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO sessions (id, created_at, updated_at, meta_json) VALUES (?, ?, ?, ?)")
      .run(id, now, now, JSON.stringify(record.meta ?? {}));
    return rowToRecord(this.db.prepare<[string], SessionRow>(
      "SELECT id, created_at, updated_at, meta_json, invoked_skills_json FROM sessions WHERE id = ?"
    ).get(id)!);
  }

  async load(id: string): Promise<SessionRecord | undefined> {
    const row = this.db.prepare<[string], SessionRow>(
      "SELECT id, created_at, updated_at, meta_json, invoked_skills_json FROM sessions WHERE id = ?"
    ).get(id);
    return row ? rowToRecord(row) : undefined;
  }

  async setInvokedSkills(id: string, skills: InvokedSkillRecord[]): Promise<void> {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET invoked_skills_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(skills), now, id);
  }

  async loadMessages(id: string): Promise<StoredMessage[]> {
    return this.db.prepare<[string], { seq: number; appended_at: string; message_json: string }>(
      "SELECT seq, appended_at, message_json FROM messages WHERE session_id = ? ORDER BY seq ASC"
    ).all(id).map(r => ({ seq: r.seq, appended_at: r.appended_at, message: JSON.parse(r.message_json) as Message }));
  }

  async appendMessages(id: string, messages: Message[]): Promise<StoredMessage[]> {
    const result: StoredMessage[] = [];
    this.db.transaction(() => {
      const row = this.db.prepare<[string], { max_seq: number | null }>(
        "SELECT MAX(seq) as max_seq FROM messages WHERE session_id = ?"
      ).get(id);
      let seq = (row?.max_seq ?? 0) + 1;
      const now = new Date().toISOString();
      const insertMsg = this.db.prepare("INSERT INTO messages (session_id, seq, appended_at, message_json) VALUES (?, ?, ?, ?)");
      for (const msg of messages) {
        insertMsg.run(id, seq, now, JSON.stringify(msg));
        result.push({ seq, appended_at: now, message: msg });
        seq++;
      }
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, id);
    })();
    return result;
  }

  async updateMeta(id: string, meta: Record<string, unknown>): Promise<SessionRecord> {
    const existing = await this.load(id);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET meta_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ ...(existing?.meta ?? {}), ...meta }), now, id);
    return (await this.load(id))!;
  }

  async list(opts?: { limit?: number; offset?: number }): Promise<SessionRecord[]> {
    return this.db.prepare<[number, number], SessionRow>(
      "SELECT id, created_at, updated_at, meta_json, invoked_skills_json FROM sessions ORDER BY updated_at DESC LIMIT ? OFFSET ?"
    ).all(opts?.limit ?? -1, opts?.offset ?? 0).map(rowToRecord);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  async createTask(sessionId: string, input: CreateTaskInput): Promise<Task> {
    let task!: Task;
    this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO task_counters (session_id, next_id) VALUES (?, 1)").run(sessionId);
      const { next_id } = this.db.prepare<[string], { next_id: number }>(
        "SELECT next_id FROM task_counters WHERE session_id = ?"
      ).get(sessionId)!;
      const taskId = String(next_id);
      const now = new Date().toISOString();
      this.db.prepare(
        "INSERT INTO tasks (session_id, id, subject, description, active_form, status, owner, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?)"
      ).run(sessionId, taskId, input.subject, input.description, input.active_form ?? null, JSON.stringify(input.metadata ?? {}), now, now);
      this.db.prepare("UPDATE task_counters SET next_id = next_id + 1 WHERE session_id = ?").run(sessionId);
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
      task = rowToTask(this.db.prepare<[string, string], TaskRow>("SELECT * FROM tasks WHERE session_id = ? AND id = ?").get(sessionId, taskId)!, [], []);
    })();
    return task;
  }

  private loadEdges(sessionId: string, taskId: string): { blocks: string[]; blocked_by: string[] } {
    const blocks = this.db.prepare<[string, string], { to_task_id: string }>(
      "SELECT to_task_id FROM task_edges WHERE session_id = ? AND from_task_id = ?"
    ).all(sessionId, taskId).map(r => r.to_task_id);
    const blocked_by = this.db.prepare<[string, string], { from_task_id: string }>(
      "SELECT from_task_id FROM task_edges WHERE session_id = ? AND to_task_id = ?"
    ).all(sessionId, taskId).map(r => r.from_task_id);
    return { blocks, blocked_by };
  }

  async getTask(sessionId: string, taskId: string): Promise<Task | undefined> {
    const row = this.db.prepare<[string, string], TaskRow>("SELECT * FROM tasks WHERE session_id = ? AND id = ?").get(sessionId, taskId);
    if (!row) return undefined;
    const { blocks, blocked_by } = this.loadEdges(sessionId, taskId);
    return rowToTask(row, blocks, blocked_by);
  }

  async listTasks(sessionId: string): Promise<Task[]> {
    return this.db.prepare<[string], TaskRow>(
      "SELECT * FROM tasks WHERE session_id = ? ORDER BY CAST(id AS INTEGER) ASC"
    ).all(sessionId).map(row => {
      const { blocks, blocked_by } = this.loadEdges(sessionId, row.id);
      return rowToTask(row, blocks, blocked_by);
    });
  }

  async updateTask(sessionId: string, taskId: string, patch: TaskPatch): Promise<Task | undefined> {
    let result: Task | undefined;
    this.db.transaction(() => {
      const row = this.db.prepare<[string, string], TaskRow>("SELECT * FROM tasks WHERE session_id = ? AND id = ?").get(sessionId, taskId);
      if (!row) return;
      if (patch.status === "deleted") { this.db.prepare("DELETE FROM tasks WHERE session_id = ? AND id = ?").run(sessionId, taskId); return; }
      const now = new Date().toISOString();
      if (patch.subject !== undefined) this.db.prepare("UPDATE tasks SET subject = ? WHERE session_id = ? AND id = ?").run(patch.subject, sessionId, taskId);
      if (patch.description !== undefined) this.db.prepare("UPDATE tasks SET description = ? WHERE session_id = ? AND id = ?").run(patch.description, sessionId, taskId);
      if (patch.active_form !== undefined) this.db.prepare("UPDATE tasks SET active_form = ? WHERE session_id = ? AND id = ?").run(patch.active_form, sessionId, taskId);
      if (patch.status !== undefined) this.db.prepare("UPDATE tasks SET status = ? WHERE session_id = ? AND id = ?").run(patch.status, sessionId, taskId);
      if (patch.owner !== undefined) this.db.prepare("UPDATE tasks SET owner = ? WHERE session_id = ? AND id = ?").run(patch.owner, sessionId, taskId);
      if (patch.metadata !== undefined) {
        const md: Record<string, unknown> = JSON.parse(row.metadata_json);
        for (const [k, v] of Object.entries(patch.metadata)) { if (v === null) delete md[k]; else md[k] = v; }
        this.db.prepare("UPDATE tasks SET metadata_json = ? WHERE session_id = ? AND id = ?").run(JSON.stringify(md), sessionId, taskId);
      }
      // Build adj for cycle detection; apply removals first, then stage additions
      const allEdges = this.db.prepare<[string], { from_task_id: string; to_task_id: string }>(
        "SELECT from_task_id, to_task_id FROM task_edges WHERE session_id = ?"
      ).all(sessionId);
      const adj = new Map<string, Set<string>>();
      for (const e of allEdges) { if (!adj.has(e.from_task_id)) adj.set(e.from_task_id, new Set()); adj.get(e.from_task_id)!.add(e.to_task_id); }
      const deleteEdge = this.db.prepare("DELETE FROM task_edges WHERE session_id = ? AND from_task_id = ? AND to_task_id = ?");
      for (const toId of patch.remove_blocks ?? []) { adj.get(taskId)?.delete(toId); deleteEdge.run(sessionId, taskId, toId); }
      for (const fromId of patch.remove_blocked_by ?? []) { adj.get(fromId)?.delete(taskId); deleteEdge.run(sessionId, fromId, taskId); }
      const toAdd: Array<[string, string]> = [];
      for (const toId of patch.add_blocks ?? []) { if (!adj.has(taskId)) adj.set(taskId, new Set()); adj.get(taskId)!.add(toId); toAdd.push([taskId, toId]); }
      for (const fromId of patch.add_blocked_by ?? []) { if (!adj.has(fromId)) adj.set(fromId, new Set()); adj.get(fromId)!.add(taskId); toAdd.push([fromId, taskId]); }
      if (toAdd.length > 0 && hasCycle(adj)) throw new Error("Dependency cycle detected");
      const insertEdge = this.db.prepare("INSERT OR IGNORE INTO task_edges (session_id, from_task_id, to_task_id, kind) VALUES (?, ?, ?, 'blocks')");
      for (const [from, to] of toAdd) insertEdge.run(sessionId, from, to);
      this.db.prepare("UPDATE tasks SET updated_at = ? WHERE session_id = ? AND id = ?").run(now, sessionId, taskId);
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
      const updatedRow = this.db.prepare<[string, string], TaskRow>("SELECT * FROM tasks WHERE session_id = ? AND id = ?").get(sessionId, taskId)!;
      const { blocks, blocked_by } = this.loadEdges(sessionId, taskId);
      result = rowToTask(updatedRow, blocks, blocked_by);
    })();
    return result;
  }

  async deleteTask(sessionId: string, taskId: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM tasks WHERE session_id = ? AND id = ?").run(sessionId, taskId).changes > 0;
  }

  async close(): Promise<void> { this.db.close(); }
}
