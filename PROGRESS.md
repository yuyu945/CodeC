# Progress

Last updated: 2026-06-05

## Status

The project now has a stable runtime core with:

- MVP-0 single-agent runtime loop
- provider boundary with a real OpenAI Responses adapter
- context compaction foundation
- project-scoped instruction resolution
- micro-compact for historical tool results

Current repository state:

- the runtime is test-driven and runnable through the local test harness
- context, instruction, replay, retry, and redaction behavior are implemented
- Anthropic provider support is not implemented yet

## Completed

### Phase 0: Design

Artifacts:

- `design.md`
- `coding-agent-runtime-system-design.zh-CN.md`
- `coding-agent-runtime-system-design.md`

Outcome:

- runtime, context, memory, tool, permission, event, replay, and provider architecture are documented
- Codex CLI and Claude Code design influences are recorded

### Phase 1: MVP-0 Vertical Slice

Completed in commit:

- `18b40fb feat: add MVP-0 agent runtime vertical slice`

Delivered:

- `AgentRuntime.runTurn()` with real model/tool loop
- typed tool result injection
- `PermissionManager`
- `ToolExecutor`
- `JsonlEventStore`
- `Replay`
- runtime, tool, permission, and E2E tests

### Phase 2: Provider Boundary

Completed in commit:

- `0f12ca6 feat: add provider-aware runtime compaction foundation`

Delivered:

- canonical `ModelAdapter` boundary
- `FakeModelAdapter`
- `OpenAIResponsesAdapter`
- provider error taxonomy and retry/abort handling
- provider-focused tests

### Phase 3: Context Pipeline

This phase is complete in the working tree and ready to be committed as one capability boundary.

Delivered:

- provider-owned budget estimation
- `AutoCompact`
- `Reactive Compact`
- `Snip`
- `MicroCompact`
- project-scoped `AGENTS.md` instruction resolution
- touched-path-aware instruction scope expansion
- instruction and compaction replay visibility
- tool-output redaction and stronger replay inspection

Why this is one coherent milestone:

- all changes are inside the same context-processing path
- compaction, instructions, and micro-compact now share the same runtime/context/replay flow
- no experimental-only logic remains outside the tested runtime path

## Current Test Surface

Test files:

- `tests/runtime.test.ts`
- `tests/tools-permissions.test.ts`
- `tests/replay-e2e.test.ts`
- `tests/providers.test.ts`
- `tests/compaction.test.ts`
- `tests/instructions.test.ts`
- `tests/module-exports.test.ts`

Covered behavior:

- runtime loop behavior
- permission decisions
- tool execution
- provider mapping
- provider retry and abort
- replay inspection
- compaction tiers
- instruction resolution and trimming
- micro-compact behavior

Current verification status:

- full suite passes locally: `34/34`

## Next Recommended Milestone

Add provider parity with an Anthropic adapter.

Scope for the next phase:

- Anthropic adapter under the existing canonical `ModelAdapter` contract
- Anthropic request/response mapping
- Anthropic tool-call normalization
- Anthropic error taxonomy mapping
- Anthropic budget estimation
- shared adapter contract validation across fake, OpenAI, and Anthropic

Do not start memory manager, MCP, observability expansion, or product surfaces before Anthropic parity is complete.

## Known Constraints

- Event storage remains local JSONL.
- There is still no product surface such as CLI/TUI/API.
- Design documents remain local reference artifacts and are not part of the committed runtime history by default.
