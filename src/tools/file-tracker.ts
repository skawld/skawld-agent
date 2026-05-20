import path from "node:path";

/**
 * Tracks which files have been Read during the current session.
 * The Edit tool checks this and refuses to edit a file that has not been Read.
 * Cleared per-session, not per-run; Reads in earlier runs still count.
 * Held in memory only — not persisted.
 */
export class FileReadTracker {
  private read = new Set<string>();

  /** Normalize to absolute path, then mark as read. */
  markRead(absPath: string): void {
    this.read.add(path.resolve(absPath));
  }

  /** Returns true if the path has been marked as read. */
  hasRead(absPath: string): boolean {
    return this.read.has(path.resolve(absPath));
  }

  /** Clear all tracked paths (e.g. on session reset). */
  clear(): void {
    this.read.clear();
  }
}
