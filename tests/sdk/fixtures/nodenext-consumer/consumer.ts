/**
 * NodeNext consumer fixture.
 *
 * Imports from all published subpaths under moduleResolution: NodeNext.
 * Each import is referenced so TypeScript does not elide it.
 * This file is compiled by the guardrail test to verify zero TS2834/TS2835 errors.
 */

import { Agent } from "skawld";
import { AnthropicProvider } from "skawld/providers";
import type { Tool } from "skawld/tools";
import type { SessionStore } from "skawld/sessions";
import { PermissionEngine } from "skawld/permissions";

// Reference each export so TypeScript does not elide the imports.
const _agent: typeof Agent = Agent;
const _provider: typeof AnthropicProvider = AnthropicProvider;
const _engine: typeof PermissionEngine = PermissionEngine;

// Type-only references — these must be used as types, not values.
type _Tool = Tool;
type _SessionStore = SessionStore;

// Satisfy "declared but never read" for value references.
void _agent;
void _provider;
void _engine;
