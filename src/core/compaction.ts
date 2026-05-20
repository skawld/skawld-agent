/** Auto-compaction: default strategy and loop hooks. See docs/05-agent-loop.html#compaction. */

import type { Message, ModelId } from "./types.js";
import type { BaseProvider, ProviderRequest } from "../providers/base.js";
import type { SessionInternal } from "./session.js";
import type { AgentInternal } from "./agent.js";
import type { CompactionEvent } from "./events.js";

export interface CompactionContext {
  messages: Message[];
  provider: BaseProvider;
  model: ModelId;
  signal: AbortSignal;
}

export interface CompactionStrategy {
  /** Stable identifier surfaced in CompactionEvent.strategy. */
  readonly id: string;
  /**
   * Produce a new message array that replaces the input.
   * Should preserve the most recent N turns intact and condense the rest.
   */
  compact(ctx: CompactionContext): Promise<Message[]>;
}

// ---------------------------------------------------------------------------
// lastNTurnBoundaries: returns the slice starting from the n-th-from-last
// assistant message boundary. Walk backwards; count each assistant message
// as one boundary. Return the slice from that index to the end.
// ---------------------------------------------------------------------------

export function lastNTurnBoundaries(messages: Message[], n: number): Message[] {
  let assistantsFound = 0;
  let boundaryIndex = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      assistantsFound++;
      if (assistantsFound === n) {
        boundaryIndex = i;
        break;
      }
    }
  }

  // Fewer than n assistant messages — return everything (compact is a no-op)
  if (assistantsFound < n) {
    return messages;
  }

  return messages.slice(boundaryIndex);
}

// ---------------------------------------------------------------------------
// summarizeWithProvider: call provider with a summarization prompt; consume
// the stream non-streamingly and return the concatenated text.
// ---------------------------------------------------------------------------

const SUMMARY_PROMPT = `Summarize the conversation so far. Capture:
- Decisions made
- Files read, written, or edited (with paths)
- Tool calls made and their outcomes
- Open questions and current task state
Keep it factual and dense. Omit greetings, restated goals, and meta commentary.`;

export async function summarizeWithProvider(
  provider: BaseProvider,
  model: ModelId,
  older: Message[],
  signal: AbortSignal,
): Promise<string> {
  const req: ProviderRequest = {
    model,
    system: [{ type: "text", text: SUMMARY_PROMPT, cacheable: false }],
    tools: [],
    messages: older,
    max_output_tokens: 4096,
    signal,
    cache_prompt: false,
  };

  let text = "";
  for await (const ev of provider.stream(req)) {
    if (ev.type === "text_delta") text += ev.text;
    if (ev.type === "message_end") break;
  }
  return text.trim();
}

// ---------------------------------------------------------------------------
// defaultCompaction: keeps last 10 turn boundaries; older messages summarized
// into a single synthetic user message at the head of the returned array.
// ---------------------------------------------------------------------------

export const defaultCompaction: CompactionStrategy = {
  id: "default-keep-recent-10",

  async compact({ messages, provider, model, signal }: CompactionContext): Promise<Message[]> {
    const recent = lastNTurnBoundaries(messages, 10);
    const older = messages.slice(0, messages.length - recent.length);

    // No older content — nothing to compact
    if (older.length === 0) return messages;

    const summaryText = await summarizeWithProvider(provider, model, older, signal);

    const summaryMessage: Message = {
      role: "user",
      content: [{ type: "text", text: `<summary of earlier conversation>\n\n${summaryText}` }],
    };

    return [summaryMessage, ...recent];
  },
};

// ---------------------------------------------------------------------------
// runCompactionImpl: shared logic for both maybeCompact and runForcedCompaction.
// Rewrites providerView in place; fullHistory is NOT touched.
// ---------------------------------------------------------------------------

async function runCompactionImpl(
  si: SessionInternal,
  ai: AgentInternal,
  signal: AbortSignal,
  strategy: CompactionStrategy,
): Promise<void> {
  const { provider, model } = ai;
  const before = {
    messages: si.providerView.length,
    tokens: si.lastUsage?.input_tokens ?? 0,
  };

  // Pass a snapshot so a misbehaving custom strategy cannot mutate the live array.
  const compacted = await strategy.compact({
    messages: si.providerView.slice(),
    provider,
    model,
    signal,
  });

  // Replace providerView in place — fullHistory is NOT touched
  si.providerView.length = 0;
  for (const m of compacted) {
    si.providerView.push(m);
  }

  // tokens_after is unknown until the next provider response (local tokenizer deferred per spec)
  si.lastCompactionInfo = {
    type: "compaction",
    messages_before: before.messages,
    messages_after: si.providerView.length,
    tokens_before: before.tokens,
    tokens_after: 0,
    strategy: strategy.id,
  };
}

// ---------------------------------------------------------------------------
// maybeCompact: checks the 80% threshold and runs compaction if needed.
// Called at the top of every turn with SessionInternal and AgentInternal.
// Returns true iff compaction ran.
// ---------------------------------------------------------------------------

export async function maybeCompact(
  si: SessionInternal,
  ai: AgentInternal,
  signal: AbortSignal,
): Promise<boolean> {
  if (si.lastUsage === undefined) return false;

  const strategy = ai.compaction ?? defaultCompaction;
  const limit = ai.provider.contextWindow(ai.model);
  const projected = si.lastUsage.input_tokens + ai.maxOutputTokens;

  if (projected < 0.8 * limit) return false;

  await runCompactionImpl(si, ai, signal, strategy);
  return true;
}

// ---------------------------------------------------------------------------
// runForcedCompaction: runs compaction unconditionally (used on ContextLengthError).
// tokens_after will be 0 — the real count appears after the next UsageEvent.
// Called by streamTurnWithContextRetry on one-shot ContextLengthError recovery.
// ---------------------------------------------------------------------------

export async function runForcedCompaction(
  si: SessionInternal,
  ai: AgentInternal,
  signal: AbortSignal,
): Promise<void> {
  const strategy = ai.compaction ?? defaultCompaction;
  await runCompactionImpl(si, ai, signal, strategy);
}

// Re-export the CompactionEvent type so the loop can read lastCompactionInfo
export type { CompactionEvent };
