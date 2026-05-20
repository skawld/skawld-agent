# AGENTS.md

This repository will contain **skawld**, an open-source TypeScript agent harness for software-engineering tasks (think: a Claude Code-like loop, with our own modifications). Right now the repository only contains a `docs/` folder. Your job is to read those docs and implement the system they describe.

## How to use this repository

1. **Start at `docs/index.html`.** It is the single entry point. It explains what skawld is, the overall architecture, the module map, the reading order, and the project glossary.
2. **Follow the reading order in `docs/index.html`.** The module docs are numbered (`00-` through `10-`). Earlier docs are foundational for later ones.
3. **Treat every doc as authoritative.** Type names, event names, error names, field names, and behaviors are normative. Do not rename or restructure them without an explicit instruction from the user.
4. **Each module doc has a "Build checklist" near the end.** Use it to track what you have implemented and what remains. Mark items off as you go.
5. **When in doubt, re-read the relevant doc.** If a doc seems ambiguous, surface the ambiguity to the user before guessing.

## What lives where

```
.
├── AGENTS.md            ← you are here
├── docs/                ← read this folder first
│   ├── index.html       ← start here
│   ├── styles.css
│   ├── 00-foundations.html
│   ├── 01-providers.html
│   ├── 02-tools.html
│   ├── 03-permissions.html
│   ├── 04-sessions.html
│   ├── 05-agent-loop.html
│   ├── 06-system-prompt.html
│   ├── 07-sdk.html
│   ├── 08-cli.html
│   ├── 09-config.html
│   └── 10-project-setup.html
└── (src/ etc. will be created by you as you implement)
```

## Hard rules

- **TypeScript only** for the core. ESM. Node 20+.
- **Single npm package** (`skawld`). No monorepo. Public API surface is controlled via the `exports` map in `package.json` (subpaths: `skawld`, `skawld/providers`, `skawld/tools`, `skawld/sessions`).
- **The core engine has zero I/O assumptions.** No `console.log`, no chalk, no terminal escapes inside `src/core/`, `src/providers/`, `src/tools/`, `src/permissions/`, `src/sessions/`. The CLI is a thin consumer of the core, just like any other application.
- **Read-before-Edit is enforced** for the `Edit` tool. See `docs/02-tools.html`.
- **Permission requests fire per tool call** via a `canUseTool` callback, modeled after the Anthropic Agent SDK. See `docs/03-permissions.html`.
- **The default system prompt is cache-optimized.** Dynamic content (date, etc.) goes into the first user message, not the system prompt. See `docs/06-system-prompt.html`.
- **The CLI is non-interactive for v1.** It streams NDJSON events on stdout and accepts JSON control messages on stdin. The interactive CLI is a future milestone — do not build it yet.

## Things explicitly deferred (do NOT build in v1)

- Subagents (persistent task-state tools are in v1; spawning or coordinating subagents is not)
- MCP support / custom tools beyond the built-ins
- WebFetch / WebSearch tools
- Hooks
- Sandboxing for Bash
- File state tracking (mtime/hash detection between Read and Edit)
- Interactive CLI / TUI
- Local tokenizer (use API-reported usage)
- A default model (the user provides the model string explicitly)

## Suggested implementation order

This mirrors the dependency graph in the docs:

1. **Project setup** — `docs/10-project-setup.html`: scaffold `package.json`, `tsconfig.json`, `tsup`, `vitest`, `src/` layout.
2. **Foundations** — `docs/00-foundations.html`: shared types, event union, error hierarchy.
3. **Providers** — `docs/01-providers.html`: `BaseProvider`, `AnthropicProvider`, `OpenAIChatCompletionsProvider`, `OpenAIResponsesProvider`.
4. **Sessions** — `docs/04-sessions.html`: `SessionStore` interface, task persistence types, `SqliteSessionStore`.
5. **Tools** — `docs/02-tools.html`: `Tool` interface, then `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `TaskCreate`, `TaskList`, `TaskGet`, `TaskUpdate`.
6. **Permissions** — `docs/03-permissions.html`: modes, rules, engine, `canUseTool` integration.
7. **System prompt** — `docs/06-system-prompt.html`: cache-optimized assembly.
8. **Agent + loop** — `docs/05-agent-loop.html`: `Agent` class, `Session` class, the loop, compaction.
9. **SDK surface** — `docs/07-sdk.html`: re-exports and public types.
10. **Config** — `docs/09-config.html`: JSON config loading and precedence.
11. **CLI** — `docs/08-cli.html`: `bin/skawld` entry, NDJSON protocol.

Tests should be written alongside each module, not at the end.

## When you finish a module

Run the build and the relevant tests. If they pass, mark the module's build checklist items as complete and move to the next module. If they fail, fix them before moving on — do **not** declare a module done with failing tests.
