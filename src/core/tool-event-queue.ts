/**
 * In-process FIFO queue for events emitted by a tool during its `execute()` call.
 *
 * The scheduler's sequential write/exec path drains this concurrently with the
 * awaited tool execution: emitted events are yielded into the parent's event
 * iterator as they arrive, between the `tool_call_start` and `tool_call_end`
 * brackets the scheduler emits around the call.
 *
 * Contract:
 *   - push(e) before close() is buffered until consumed.
 *   - close() ends iteration; further push() is dropped (late emit, no-throw).
 *   - The async iterator drains the buffer first, then awaits a pending push/close.
 *
 * Single-consumer. Single JS thread, so no preemption between sync ops.
 */

import type { Event } from "./events.js";

export class ToolEventQueue {
  private buffer: Event[] = [];
  private resolver: ((value: IteratorResult<Event>) => void) | null = null;
  private closed = false;

  push(e: Event): void {
    if (this.closed) return; // late emit, silently dropped
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r({ value: e, done: false });
    } else {
      this.buffer.push(e);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.resolver) {
      const r = this.resolver;
      this.resolver = null;
      r({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Event> {
    return {
      next: (): Promise<IteratorResult<Event>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<Event>>((resolve) => {
          this.resolver = resolve;
        });
      },
    };
  }
}
