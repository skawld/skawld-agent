# skawld

An open-source TypeScript agent harness for software-engineering tasks.
Embed a full agent loop — tools, sessions, permissions, streaming events — into any Bun application with a single import.

```
bun add skawld
```

skawld is Bun-native, ESM-only, and requires Bun 1.1 or newer.

---

## Minimal usage

```ts
import { Agent } from "skawld";
import { AnthropicProvider } from "skawld/providers";
import { defaultTools } from "skawld/tools";

const agent = new Agent({
  provider: new AnthropicProvider(),   // reads ANTHROPIC_API_KEY from env
  model: "claude-opus-4-5",
  tools: defaultTools(),
  permissions: { mode: "default" },
});

const session = await agent.session();

for await (const event of session.run("List the files in the current directory.")) {
  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "text") process.stdout.write(block.text);
    }
  }
  if (event.type === "result") break;
}

await agent.close();
```

See [`examples/minimal-agent.ts`](./examples/minimal-agent.ts) for a complete runnable version.

---

## Providers

| Provider class | Subpath | Environment variable |
|---|---|---|
| `AnthropicProvider` | `skawld/providers` | `ANTHROPIC_API_KEY` |
| `OpenAIChatCompletionsProvider` | `skawld/providers` | `OPENAI_API_KEY` |
| `OpenAIResponsesProvider` | `skawld/providers` | `OPENAI_API_KEY` |

```ts
import {
  AnthropicProvider,
  OpenAIChatCompletionsProvider,
  OpenAIResponsesProvider,
} from "skawld/providers";
```

---

## Environment variables

| Variable | Used by |
|---|---|
| `ANTHROPIC_API_KEY` | `AnthropicProvider` (falls back to SDK default lookup) |
| `OPENAI_API_KEY` | `OpenAIChatCompletionsProvider`, `OpenAIResponsesProvider` |

---

## Sessions

By default, sessions persist to SQLite at `.skawld/sessions.db`. For tests or embedded applications, pass a custom `sessionStore`, such as `InMemorySessionStore`.

```ts
import { Agent } from "skawld";
import { InMemorySessionStore } from "skawld/sessions";

const agent = new Agent({
  provider,
  model,
  sessionStore: new InMemorySessionStore(),
});
```

---

## Public API surface

```
skawld           → Agent, Session, defaultTools, MCP helpers, core types, Event types, Error classes
skawld/providers → AnthropicProvider, OpenAIChatCompletionsProvider, OpenAIResponsesProvider, BaseProvider
skawld/tools     → ToolRegistry, defaultTools, built-in tool classes, MCP tool helpers, task types
skawld/sessions  → SqliteSessionStore, InMemorySessionStore, SessionStore and task persistence types
skawld/permissions → PermissionEngine, permission callback types, permission rule types
```

---

## v1 scope — what is and is not included

**In v1:**
- Agent loop with tool execution and compaction
- Built-in tools: Read, Write, Edit, Bash, Glob, Grep, TaskCreate/List/Get/Update
- Anthropic and OpenAI providers (Chat Completions + Responses API)
- SQLite-backed session persistence
- Permission engine (allow/deny rules, `canUseTool` callback)
- Streaming NDJSON events

**Explicitly deferred (not in v1):**
- Interactive CLI / TUI
- MCP (Model Context Protocol) support
- WebFetch / WebSearch tools
- Subagent spawning / coordination
- Sandboxing for Bash
- Config file (`skawld.config.json`)
---

## License

MIT
