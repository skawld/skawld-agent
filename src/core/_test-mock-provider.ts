/**
 * Scriptable BaseProvider for testing. Allows enqueuing turn scripts that
 * define the sequence of ProviderStreamEvents (or errors) to emit.
 */

import { AbortError } from "./errors.js";
import type { BaseProvider, ProviderRequest, ProviderStreamEvent } from "../providers/base.js";
import type { ModelId } from "./types.js";

export interface MockTurnScript {
  /** Stream events played in order. */
  events: ProviderStreamEvent[];
  /** Throw this error before yielding the first event. */
  throwBefore?: Error;
  /**
   * Throw `throwBefore` (or a generic error) after yielding the event at this index.
   * 0 = throw after yielding events[0], etc. Requires throwBefore to be set.
   */
  throwAfterIndex?: number;
  /**
   * If set, the provider will pause before yielding events[holdAt] until
   * the returned deferred resolves. Used for abort-mid-stream tests.
   */
  holdAt?: number;
  /** Optional delay in ms between each yielded event. */
  delayMs?: number;
}

/** A deferred that tests can resolve/reject externally. */
export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export function makeDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export type MockRequestMatcher = (req: ProviderRequest) => boolean;

export class MockProvider implements BaseProvider {
  readonly id = "mock";

  private turns: Array<{ script: MockTurnScript; deferred?: Deferred }> = [];
  private cursor = 0;
  /**
   * Keyed scripts: each entry has a predicate over ProviderRequest. When
   * stream() is called, it first scans this list for the first unconsumed
   * match; only when no keyed script matches does it fall back to the cursor
   * queue. Enables parallel-subagent tests where concurrent stream() calls
   * would otherwise race the single cursor.
   */
  private keyedTurns: Array<{
    match: MockRequestMatcher;
    script: MockTurnScript;
    deferred: Deferred;
    consumed: boolean;
  }> = [];

  contextWindow(_model: ModelId): number {
    return 200_000;
  }

  /**
   * Enqueue a turn script. Returns a Deferred that the caller can use to
   * control the holdAt pause (if script.holdAt is set).
   */
  enqueue(script: MockTurnScript): Deferred {
    const deferred = makeDeferred();
    this.turns.push({ script, deferred });
    return deferred;
  }

  /**
   * Enqueue a turn script that is only consumed when `match(req)` returns true.
   * Useful for parallel-subagent tests where the cursor-based queue races.
   * Scripts match in enqueue order; once consumed, a script is not re-used.
   */
  enqueueFor(match: MockRequestMatcher, script: MockTurnScript): Deferred {
    const deferred = makeDeferred();
    this.keyedTurns.push({ match, script, deferred, consumed: false });
    return deferred;
  }

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    // Prefer keyed match (first unconsumed predicate that matches).
    let script: MockTurnScript;
    let deferred: Deferred | undefined;
    const keyed = this.keyedTurns.find((k) => !k.consumed && k.match(req));
    if (keyed !== undefined) {
      keyed.consumed = true;
      script = keyed.script;
      deferred = keyed.deferred;
    } else {
      const slot = this.turns[this.cursor];
      if (!slot) {
        throw new Error(`MockProvider: no script enqueued for turn ${this.cursor}`);
      }
      this.cursor++;
      script = slot.script;
      deferred = slot.deferred;
    }

    // Check abort before anything
    if (req.signal.aborted) {
      throw new AbortError("aborted");
    }

    // Throw before first event if configured
    if (script.throwBefore) {
      throw script.throwBefore;
    }

    for (let i = 0; i < script.events.length; i++) {
      // Re-check abort on each event
      if (req.signal.aborted) {
        throw new AbortError("aborted");
      }

      // Hold-at pause: wait for deferred before yielding events[holdAt]
      if (script.holdAt !== undefined && deferred && i === script.holdAt) {
        await deferred.promise;
        // After resuming, check abort again
        if (req.signal.aborted) {
          throw new AbortError("aborted");
        }
      }

      if (script.delayMs) {
        await new Promise<void>(r => setTimeout(r, script.delayMs));
      }

      yield script.events[i]!;

      // Throw after yielding event at throwAfterIndex if configured
      if (script.throwAfterIndex !== undefined && i === script.throwAfterIndex) {
        throw script.throwBefore ?? new Error(`MockProvider: throwAfterIndex triggered at index ${i}`);
      }
    }
  }
}
