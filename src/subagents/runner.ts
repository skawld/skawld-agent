/**
 * Subagent runner: spawn a child Session under the parent's Agent, drive it
 * synchronously, wrap each child event as `SubagentEvent`, and return the
 * child's final assistant text. See docs/12-subagents.html (pending).
 */

import os from "node:os";
import { getAgentInternals } from "../core/agent.js";
import { Session, getSessionInternals } from "../core/session.js";
import { buildSystemBlocks } from "../core/system-prompt.js";
import { SKAWLD_VERSION } from "../core/version.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Event } from "../core/events.js";
import type { SessionInternal } from "../core/session.js";
import type { AgentDefinition } from "./types.js";

export interface RunSubagentArgs {
  /** Parent Session's internals — provides the agent reference + identity. */
  parent: SessionInternal;
  definition: AgentDefinition;
  /** User-message body for the child's first turn. */
  prompt: string;
  /** UI display name. 'Researcher' for named agents, 'Agent #N' for the default. */
  displayName: string;
  /** Unique per spawn — used to correlate SubagentEvent envelopes for this run. */
  subagentRunId: string;
  /**
   * Optional explicit tool filter. When omitted, the runner reads the filter off
   * the definition's frontmatter. `["*"]` or undefined = wildcard (pass-through
   * the parent's full registry). Tool names that don't resolve are silently
   * dropped at spawn time — see `buildChildTools`.
   */
  toolsFilter?: string[];
  /** Parent's tool-call signal. When fired, the child is aborted. */
  signal: AbortSignal;
  /** Push wrapped events into the parent's event stream. Wired from `ctx.emit`. */
  emit: (event: Event) => void;
}

export interface RunSubagentResult {
  childSessionId: string;
  /** The child's last assistant message text content (empty when none). */
  finalText: string;
  aborted: boolean;
  errored: boolean;
}

/**
 * Build the child's filtered tool registry view.
 *
 * Wildcard (`undefined` or includes `"*"`) returns the parent registry directly.
 * Otherwise a fresh ToolRegistry is built with only the named tools that
 * resolve in the parent; unknown names are silently dropped (matches Claude).
 *
 * A non-wildcard filter that omits `Subagent` forbids further nesting — by
 * design, no auto-re-inclusion.
 */
export function buildChildTools(
  parent: ToolRegistry,
  filter: string[] | undefined,
): ToolRegistry {
  if (filter === undefined || filter.includes("*")) return parent;
  const wanted = new Set(filter);
  const child = new ToolRegistry();
  for (const t of parent.list()) {
    if (wanted.has(t.name)) child.register(t);
  }
  return child;
}

/**
 * Spawn a subagent. Returns when the child's iterator terminates. Runtime
 * issues (provider errors, abort, child errors) are surfaced via the
 * `aborted`/`errored` flags rather than thrown.
 */
export async function runSubagent(args: RunSubagentArgs): Promise<RunSubagentResult> {
  const parent = args.parent;
  const agent = parent.agent;
  const ai = getAgentInternals(agent);
  const store = ai.getStore();

  const childRecord = await store.create({
    meta: {
      parentSessionId: parent.id,
      subagentType: args.definition.frontmatter.name,
      subagentRunId: args.subagentRunId,
      displayName: args.displayName,
    },
  });

  const toolsFilter = args.toolsFilter ?? args.definition.frontmatter.tools;
  const childTools = buildChildTools(ai.tools, toolsFilter);

  // Agent body becomes the `userInstructions` block; identity/env/tool-protocol
  // blocks remain identical to the parent so cache prefixes line up.
  const childSystemBlocks = buildSystemBlocks({
    userInstructions: args.definition.body,
    cwd: ai.cwd,
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    shell: process.env.SHELL ?? "unknown",
    nodeVersion: process.version,
    skawldVersion: SKAWLD_VERSION,
    toolNames: childTools.list().map((t) => t.name).sort(),
    permissionMode: agent.opts.permissions?.mode ?? "default",
  });

  // Construct the child Session directly so we bypass MCP/skills re-connect.
  // The child IS registered in `ai.sessions` so a nested Subagent or Skill
  // call from within can look up its session by id (unregistered in finally).
  const childSession = new Session({
    record: childRecord,
    providerView: [],
    agent,
    store,
  });
  const childInternal = getSessionInternals(childSession);
  childInternal.toolsOverride = childTools;
  childInternal.systemBlocksOverride = childSystemBlocks;
  ai.sessions.set(childRecord.id, childInternal);

  // Chain abort two ways: passing args.signal to Session.run covers
  // pre-abort/turn-boundary cases via anySignal; the listener covers
  // mid-stream aborts that fire after the loop is awaiting the provider.
  const onParentAbort = (): void => {
    childSession.abort(args.signal.reason);
  };
  if (!args.signal.aborted) {
    args.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  let aborted = false;
  let errored = false;
  // Track the LAST assistant message's joined text — not the
  // last-text-block-anywhere — so multi-block content (e.g. text/thinking/text)
  // is preserved within the final message.
  let lastAssistantText = "";
  try {
    for await (const event of childSession.run(args.prompt, { signal: args.signal })) {
      args.emit({
        type: "subagent_event",
        parent_session_id: parent.id,
        subagent_run_id: args.subagentRunId,
        subagent_type: args.definition.frontmatter.name,
        display_name: args.displayName,
        event,
      });
      if (event.type === "assistant") {
        const text = event.message.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (text.length > 0) lastAssistantText = text;
      } else if (event.type === "result" && event.subtype === "aborted") {
        aborted = true;
      } else if (event.type === "error") {
        errored = true;
      }
    }
  } catch {
    // runLoop converts everything to a terminal ResultEvent; defense in depth.
    errored = true;
  } finally {
    args.signal.removeEventListener("abort", onParentAbort);
    ai.sessions.delete(childRecord.id);
  }

  return {
    childSessionId: childRecord.id,
    finalText: lastAssistantText,
    aborted,
    errored,
  };
}
