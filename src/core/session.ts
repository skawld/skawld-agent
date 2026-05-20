/** Session class. See docs/05-agent-loop.html#session. */

import { ConfigError } from "./errors.js";
import { FileReadTracker } from "../tools/file-tracker.js";
import { runLoop } from "./loop.js";
import type { Agent } from "./agent.js";
import type { Message, Usage } from "./types.js";
import type { SessionRecord, SessionStore } from "../sessions/store.js";
import type { CompactionEvent, Event } from "./events.js";

export interface RunOptions {
  /** Caller-provided signal; chained with the session's internal one. */
  signal?: AbortSignal;
  /** Per-run override of max output tokens. */
  maxOutputTokens?: number;
  /** Per-run override of the temperature. */
  temperature?: number;
  /** Attach images to the user prompt. */
  images?: Array<{ data: string; mediaType: string } | { url: string }>;
}

/** Internal state accessible to the loop and scheduler (Phase 3+). */
export interface SessionInternal {
  id: string;
  agent: Agent;
  store: SessionStore;
  /** In-memory message history sent to the provider. May diverge from fullHistory after compaction. */
  providerView: Message[];
  /** Full message history — always all messages, including pre-compaction ones. */
  fullHistory: Message[];
  fileReadTracker: FileReadTracker;
  lastUsage: Usage | undefined;
  compactionRetryUsedThisTurn: boolean;
  internalController: AbortController;
  /** Set by runLoop when it starts; null when idle. */
  activeRunId: string | null;
  /** Append messages to both providerView, fullHistory, and the store. */
  append(messages: Message[]): Promise<void>;
  /**
   * Stashed compaction info for the loop to read via buildCompactionEvent.
   * Set by runCompactionImpl; read once by the loop to yield CompactionEvent.
   */
  lastCompactionInfo?: CompactionEvent;
  /** Record that compaction retry was used this turn. */
  markCompactionUsed(): void;
}

const sessionInternals = new WeakMap<Session, SessionInternal>();

/** Package-private accessor used by loop / scheduler (Phase 3+). */
export function getSessionInternals(session: Session): SessionInternal {
  const internals = sessionInternals.get(session);
  if (!internals) throw new Error("Session internals not found");
  return internals;
}

interface SessionConstructorArgs {
  record: SessionRecord;
  providerView: Message[];
  agent: Agent;
  store: SessionStore;
}

/**
 * Wraps an AsyncGenerator with explicit cleanup on:
 *   - Normal completion (done === true via next())
 *   - Consumer calling return() (for-await break, explicit .return())
 *   - Consumer calling throw()
 *   - GC via FinalizationRegistry (handles pure abandonment without calling return())
 *
 * This prevents _activeRunId from leaking when the consumer abandons the iterator.
 */
function makeCleanupIterator<T>(
  gen: AsyncGenerator<T>,
  cleanup: () => void,
): AsyncGenerator<T> {
  let cleaned = false;
  function runCleanup() {
    if (!cleaned) {
      cleaned = true;
      cleanup();
    }
  }

  const registry = new FinalizationRegistry<() => void>((fn) => fn());

  const iter: AsyncGenerator<T> = {
    async next(...args: [] | [undefined]): Promise<IteratorResult<T>> {
      const r = await gen.next(...args);
      if (r.done) runCleanup();
      return r;
    },
    async return(value): Promise<IteratorResult<T>> {
      runCleanup();
      return gen.return(value);
    },
    async throw(err): Promise<IteratorResult<T>> {
      runCleanup();
      return gen.throw(err);
    },
    [Symbol.asyncIterator](): AsyncGenerator<T> {
      return this;
    },
  };

  registry.register(iter, runCleanup);
  return iter;
}

export class Session {
  public readonly id: string;
  public readonly createdAt: Date;
  public readonly meta: Record<string, unknown>;

  constructor({ record, providerView, agent, store }: SessionConstructorArgs) {
    this.id = record.id;
    this.createdAt = new Date(record.created_at);
    this.meta = record.meta;

    const fullHistory = providerView.slice();
    const internalController = new AbortController();

    const internal: SessionInternal = {
      id: record.id,
      agent,
      store,
      providerView,
      fullHistory,
      fileReadTracker: new FileReadTracker(),
      lastUsage: undefined,
      compactionRetryUsedThisTurn: false,
      internalController,
      activeRunId: null,
      async append(messages: Message[]): Promise<void> {
        await store.appendMessages(record.id, messages);
        for (const m of messages) {
          providerView.push(m);
          fullHistory.push(m);
        }
      },
      markCompactionUsed(): void {
        internal.compactionRetryUsedThisTurn = true;
      },
    };

    sessionInternals.set(this, internal);
  }

  /** Total number of messages the provider sees (NOT fullHistory). */
  get messageCount(): number {
    return sessionInternals.get(this)!.providerView.length;
  }

  /**
   * Run the agent with a new user prompt. Returns an async iterator of Event.
   * Throws ConfigError synchronously if a run is already active.
   */
  run(prompt: string, opts: RunOptions = {}): AsyncIterable<Event> {
    const internal = sessionInternals.get(this)!;

    if (internal.activeRunId !== null) {
      throw new ConfigError("Session already has an active run");
    }

    // Mark as pending synchronously; runLoop will replace with actual runId.
    internal.activeRunId = "pending";

    const gen = runLoop(this, prompt, opts);
    return makeCleanupIterator(gen, () => {
      internal.activeRunId = null;
    });
  }

  /**
   * Cancel the currently running iteration. Idempotent.
   * The next event yielded will be a ResultEvent with subtype "aborted".
   */
  abort(reason?: unknown): void {
    sessionInternals.get(this)!.internalController.abort(reason);
  }

  /** Update metadata in the store (shallow merge). */
  async updateMeta(patch: Record<string, unknown>): Promise<void> {
    const internal = sessionInternals.get(this)!;
    const updated = await internal.store.updateMeta(this.id, patch);
    // Merge the patch into the in-memory meta.
    Object.assign(this.meta, updated.meta);
  }
}
