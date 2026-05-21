/** Agent class. See docs/05-agent-loop.html#agent. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { ConfigError } from "./errors.js";
import { buildSystemBlocks } from "./system-prompt.js";
import { PermissionEngine } from "../permissions/engine.js";
import { defaultTools, ToolRegistry } from "../tools/registry.js";
import { SqliteSessionStore } from "../sessions/sqlite.js";
import { Session } from "./session.js";
import type { BaseProvider } from "../providers/base.js";
import type { SystemBlock } from "../providers/base.js";
import type { SessionStore } from "../sessions/store.js";
import type { PermissionMode } from "./types.js";
import type { CanUseTool } from "../permissions/engine.js";
import type { PermissionRule } from "../permissions/rules.js";
import { defaultCompaction } from "./compaction.js";
import type { CompactionStrategy } from "./compaction.js";
import type { ModelId } from "./types.js";

export interface AgentOptions {
  /** LLM provider. Required. */
  provider: BaseProvider;
  /** Model id string. Required (skawld has no default). */
  model: ModelId;
  /** Tool registry. If omitted, defaults to the built-in tools. */
  tools?: ToolRegistry;
  /** Permission configuration. */
  permissions?: {
    mode?: PermissionMode;
    rules?: PermissionRule[];
    canUseTool?: CanUseTool;
  };
  /**
   * Where to persist sessions.
   * Defaults to SqliteSessionStore at .skawld/sessions.db, constructed lazily on
   * the first session() call so tests that supply their own store never touch disk.
   */
  sessionStore?: SessionStore;
  /** Working directory for tools. Defaults to process.cwd(). */
  cwd?: string;
  /** Additional system-prompt text appended after the default. */
  systemPrompt?: string;
  /** Override compaction. Defaults to the built-in strategy at 80% of context window. */
  compaction?: CompactionStrategy;
  /** Max retries for retryable provider errors. Default 5. */
  maxRetries?: number;
  /** Max output tokens per turn. Default 8192. */
  maxOutputTokens?: number;
  /** Emit partial_assistant events with token deltas. Default false. */
  includePartialMessages?: boolean;
  /** Hard cap on turns per run, to prevent runaway loops. Default 100. */
  maxTurns?: number;
  /**
   * Prompt-cache TTL hint. Default "5m" (Anthropic's standard ephemeral cache).
   * Set to "1h" for long-idle sessions where gaps between turns may exceed 5 min;
   * costs 2x base on cache write but keeps the prefix warm for an hour.
   * Only affects providers with explicit cache control (Anthropic); OpenAI ignores.
   */
  cacheTtl?: "5m" | "1h";
}

/** Internal state accessible to the loop and scheduler (Phase 3+). */
export interface AgentInternal {
  provider: BaseProvider;
  model: ModelId;
  tools: ToolRegistry;
  permissionEngine: PermissionEngine;
  /** Returns (or lazily creates) the session store. */
  getStore: () => SessionStore;
  /** Close the store if it was ever allocated; no-op otherwise. */
  closeStore: () => Promise<void>;
  cwd: string;
  systemBlocks: SystemBlock[];
  maxRetries: number;
  maxOutputTokens: number;
  includePartialMessages: boolean;
  maxTurns: number;
  compaction: CompactionStrategy | undefined;
  cacheTtl: "5m" | "1h" | undefined;
}

const agentInternals = new WeakMap<Agent, AgentInternal>();

/** Package-private accessor used by loop / scheduler (Phase 3+). */
export function getAgentInternals(agent: Agent): AgentInternal {
  const internals = agentInternals.get(agent);
  if (!internals) throw new Error("Agent internals not found");
  return internals;
}

function readSkawldVersion(): string {
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url);
    const raw = readFileSync(fileURLToPath(pkgUrl), "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

export class Agent {
  public readonly opts: AgentOptions;

  constructor(opts: AgentOptions) {
    if (!opts.provider) throw new ConfigError("Agent requires a provider");
    if (!opts.model) throw new ConfigError("Agent requires a model");

    this.opts = opts;

    const cwd = opts.cwd ?? process.cwd();
    const tools = opts.tools ?? defaultTools();
    const permMode: PermissionMode = opts.permissions?.mode ?? "default";
    const permRules = opts.permissions?.rules ?? [];

    const permissionEngine = new PermissionEngine({
      mode: permMode,
      rules: permRules,
      canUseTool: opts.permissions?.canUseTool,
      projectRoot: cwd,
    });

    const skawldVersion = readSkawldVersion();
    const toolNames = tools.list().map(t => t.name).sort();

    const systemBlocks = buildSystemBlocks({
      userInstructions: opts.systemPrompt,
      cwd,
      os: { platform: process.platform, release: os.release(), arch: process.arch },
      shell: process.env.SHELL ?? "unknown",
      nodeVersion: process.version,
      skawldVersion,
      toolNames,
      permissionMode: permMode,
    });

    // Lazy store: the SqliteSessionStore is only instantiated on the first
    // session() call. If the caller passed their own store, use it directly.
    let _store: SessionStore | undefined = opts.sessionStore;

    const getStore = (): SessionStore => {
      if (!_store) {
        _store = new SqliteSessionStore({ cwd });
      }
      return _store;
    };

    const closeStore = async (): Promise<void> => {
      // Only close if the store was actually allocated.
      await _store?.close?.();
    };

    agentInternals.set(this, {
      provider: opts.provider,
      model: opts.model,
      tools,
      permissionEngine,
      getStore,
      closeStore,
      cwd,
      systemBlocks,
      maxRetries: opts.maxRetries ?? 5,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
      includePartialMessages: opts.includePartialMessages ?? false,
      maxTurns: opts.maxTurns ?? 100,
      compaction: opts.compaction ?? defaultCompaction,
      cacheTtl: opts.cacheTtl,
    });
  }

  /** Create or resume a session. */
  async session(input?: { id?: string; meta?: Record<string, unknown> }): Promise<Session> {
    const { getStore } = getAgentInternals(this);
    const store = getStore();

    const record = await store.create({ id: input?.id, meta: input?.meta });

    // Resume: load persisted messages. New session: start empty.
    const storedMessages = input?.id ? await store.loadMessages(input.id) : [];
    const providerView = storedMessages.map(sm => sm.message);

    return new Session({ record, providerView, agent: this, store });
  }

  /**
   * Release resources. Closes the session store only if it was ever allocated,
   * so tests that never call session() do not inadvertently create a SQLite file.
   */
  async close(): Promise<void> {
    const internal = agentInternals.get(this);
    await internal?.closeStore();
  }
}
