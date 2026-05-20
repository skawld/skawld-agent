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

export class MockProvider implements BaseProvider {
  readonly id = "mock";

  private turns: Array<{ script: MockTurnScript; deferred?: Deferred }> = [];
  private cursor = 0;

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

  async *stream(req: ProviderRequest): AsyncIterable<ProviderStreamEvent> {
    const slot = this.turns[this.cursor];
    if (!slot) {
      throw new Error(`MockProvider: no script enqueued for turn ${this.cursor}`);
    }
    this.cursor++;
    const { script, deferred } = slot;

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
