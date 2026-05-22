# CLAUDE.md

This repository will contain **skawld**, an open-source TypeScript agent harness for software-engineering tasks (think: a Claude Code-like loop, with our own modifications). Right now the repository only contains a `docs/` folder. Your job is to read those docs and implement the system they describe.

## Behavioral guidelines

Behavioral rules to reduce common LLM coding mistakes. These bias toward caution over speed; for trivial tasks, use judgment.

### 1. Think before coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity first

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: every changed line should trace directly to the user's request.

### 4. Goal-driven execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass."
- "Fix the bug" → "Write a test that reproduces it, then make it pass."
- "Refactor X" → "Ensure tests pass before and after."

For multi-step tasks, state a brief plan:

```
1. [step] → verify: [check]
2. [step] → verify: [check]
3. [step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

### 5. Test after every change

**No change is "done" until tests run green.**

After any code change — even a one-line edit — run the relevant tests before reporting back:

- After editing a file: `bun test path/to/file.test.ts` (or the whole suite if scope is unclear).
- After finishing a module: `bun run typecheck && bun test && bun run build`.
- After changing build/config: full smoke (`bun install`, `bun run typecheck`, `bun run build`, `bun test`).
- If you cannot test (UI/runtime not reachable from here): say so explicitly. Do not claim success.

Type checking and build success verify code correctness, not feature correctness. Run the tests.

If tests fail: fix the cause, don't ignore, skip, or weaken the test. Never `--no-verify`, `.only`, `.skip`, or weaken assertions to pass.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

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

- **TypeScript only** for the core. ESM. Bun 1.1+ (Bun-native — no Node runtime support). `bun build` for JS, `tsc --emitDeclarationOnly` for `.d.ts`, `bun test` for tests, `bun:sqlite` for the session store.
- **Single npm package** (`skawld`). No monorepo. Public API surface is controlled via the `exports` map in `package.json` (subpaths: `skawld`, `skawld/providers`, `skawld/tools`, `skawld/sessions`).
- **The core engine has zero I/O assumptions.** No `console.log`, no chalk, no terminal escapes inside `src/core/`, `src/providers/`, `src/tools/`, `src/permissions/`, `src/sessions/`. The CLI is a thin consumer of the core, just like any other application.
- **Read-before-Edit is enforced** for the `Edit` tool. See `docs/02-tools.html`.
- **Permission requests fire per tool call** via a `canUseTool` callback, modeled after the Anthropic Agent SDK. See `docs/03-permissions.html`.
- **The default system prompt is cache-optimized.** Dynamic content (date, etc.) goes into the first user message, not the system prompt. See `docs/06-system-prompt.html`.
- **The CLI is non-interactive for v1.** It streams NDJSON events on stdout and accepts JSON control messages on stdin. The interactive CLI is a future milestone — do not build it yet.

## Things explicitly deferred (do NOT build in v1)

- Subagents (persistent task-state tools are in v1; spawning or coordinating subagents is not)
- WebFetch / WebSearch tools
- Hooks
- Sandboxing for Bash
- File state tracking (mtime/hash detection between Read and Edit)
- Interactive CLI / TUI
- Local tokenizer (use API-reported usage)
- A default model (the user provides the model string explicitly)

## Suggested implementation order

This mirrors the dependency graph in the docs:

1. **Project setup** — `docs/10-project-setup.html`: scaffold `package.json`, `tsconfig.json`, `bun build` + `tsc --emitDeclarationOnly`, `bun test`, `src/` layout.
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

1. Run `bun run typecheck && bun test && bun run build`. All three must pass — do **not** declare a module done with failing tests, type errors, or a broken build. (Module-level form of the "Test after every change" rule above.)
2. **Update the build checklist** in the relevant `docs/NN-*.html` file. Tick each completed item by replacing its `<li>...</li>` with `<li><input type="checkbox" checked disabled> ...</li>`. Leave items unchecked (`<input type="checkbox" disabled>`) only if they were genuinely out of scope, and call them out in the response so the user can decide whether to do them now.
3. Add a one-line **status** under the checklist heading: e.g. `<p><strong>Status: complete.</strong> Verified by bun run typecheck, bun test (N/N passing), and bun run build.</p>` — or `Status: scaffold complete; X and Y still open.` when some items remain.
4. Only then move to the next module.

A module is not "done" until both the code is green **and** the doc's checklist reflects reality. Out-of-date checklists mislead the next session.
